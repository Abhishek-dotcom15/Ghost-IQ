import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import {
  RunTestCommand,
  SessionCompletedEvent,
  SocketEvents,
  StepCompletedEvent,
  StepStartedEvent,
  normalizeEndpointUrl,
} from '@ghostiq/shared';
import type { PrismaClient } from './db.js';
import type { Env } from './env.js';
import { computeFlakinessScore, updateRunningAverage } from './lib/flakiness.js';
import type { AiService } from './services/ai.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  ai: AiService;
}

export interface GhostIqApp {
  app: Express;
  server: http.Server;
  io: Server;
}

const DEFAULT_GOAL = 'Explore the page and verify critical actions like login, nav, and inputs.';

/**
 * Builds the HTTP server, Express app and Socket.IO hub without listening,
 * so tests can drive it with supertest.
 */
export function createApp({ env, prisma, ai }: AppDeps): GhostIqApp {
  const corsOrigins = env.GHOSTIQ_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1.5e7, // screenshots travel as base64 for now (moved to uploads in Phase 2)
  });

  const screenshotsDir = path.resolve(env.GHOSTIQ_SCREENSHOT_DIR);
  fs.mkdirSync(screenshotsDir, { recursive: true });

  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/screenshots', express.static(screenshotsDir, { fallthrough: false }));

  // projectId -> connected runner socket
  const connectedAgents = new Map<string, Socket>();

  // ---------------------------------------------------------------- sockets
  io.on('connection', (socket) => {
    const { role, projectId } = socket.handshake.query;

    if (role !== 'agent' || typeof projectId !== 'string' || !projectId) return;

    connectedAgents.set(projectId, socket);
    console.log(`[agent] connected for project ${projectId}`);
    io.emit(SocketEvents.agentStatusChange, { projectId, status: 'online' });

    socket.on('disconnect', () => {
      if (connectedAgents.get(projectId) === socket) connectedAgents.delete(projectId);
      io.emit(SocketEvents.agentStatusChange, { projectId, status: 'offline' });
    });

    socket.on(SocketEvents.stepStarted, (raw: unknown) => {
      const parsed = StepStartedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.stepStarted, parsed.error);
      const data = parsed.data;
      io.emit(SocketEvents.sessionUpdate(data.sessionId), { type: 'step-started', data });
    });

    socket.on(SocketEvents.stepCompleted, async (raw: unknown) => {
      const parsed = StepCompletedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.stepCompleted, parsed.error);
      const data = parsed.data;

      try {
        const session = await prisma.testSession.findUnique({ where: { id: data.sessionId } });
        if (!session || session.projectId !== projectId) {
          console.warn(`[agent] step for unknown or foreign session ${data.sessionId} ignored`);
          return;
        }

        let screenshotUrl: string | null = null;
        if (data.screenshotBase64) {
          const filename = `${session.id}_${data.stepNumber}.png`;
          await fs.promises.writeFile(
            path.join(screenshotsDir, filename),
            Buffer.from(data.screenshotBase64, 'base64'),
          );
          screenshotUrl = `/screenshots/${filename}`;
        }

        const step = await prisma.testStep.create({
          data: {
            sessionId: session.id,
            stepNumber: data.stepNumber,
            action: data.action,
            description: data.description,
            selector: data.selector ?? null,
            value: data.value ?? null,
            status: data.status,
            error: data.error ?? null,
            screenshotPath: screenshotUrl,
            a11yViolations: data.a11yViolations ?? null,
          },
        });

        for (const req of data.networkRequests) {
          await prisma.networkRequest.create({
            data: {
              stepId: step.id,
              url: req.url,
              method: req.method,
              status: req.status,
              latencyMs: req.latencyMs,
            },
          });

          const url = normalizeEndpointUrl(req.url);
          const isError = req.status >= 400 || req.status === 0;
          const key = {
            projectId_url_method: { projectId: session.projectId, url, method: req.method },
          };
          const existing = await prisma.endpointHealth.findUnique({ where: key });

          if (existing) {
            await prisma.endpointHealth.update({
              where: { id: existing.id },
              data: {
                callCount: existing.callCount + 1,
                errorCount: existing.errorCount + (isError ? 1 : 0),
                avgLatencyMs: updateRunningAverage(
                  existing.avgLatencyMs,
                  existing.callCount,
                  req.latencyMs,
                ),
                lastCalled: new Date(),
              },
            });
          } else {
            await prisma.endpointHealth.create({
              data: {
                projectId: session.projectId,
                url,
                method: req.method,
                callCount: 1,
                errorCount: isError ? 1 : 0,
                avgLatencyMs: req.latencyMs,
              },
            });
          }
        }

        io.emit(SocketEvents.sessionUpdate(session.id), {
          type: 'step-completed',
          data: { ...step, networkLogs: data.networkRequests },
        });
      } catch (err) {
        console.error('[agent] failed to persist step:', err);
      }
    });

    socket.on(SocketEvents.sessionCompleted, async (raw: unknown) => {
      const parsed = SessionCompletedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.sessionCompleted, parsed.error);
      const data = parsed.data;

      try {
        const session = await prisma.testSession.findUnique({ where: { id: data.sessionId } });
        if (!session || session.projectId !== projectId) return;

        await prisma.testSession.update({
          where: { id: session.id },
          data: { status: data.status, endedAt: new Date() },
        });

        const history = await prisma.testSession.findMany({
          where: {
            projectId: session.projectId,
            targetUrl: session.targetUrl,
            persona: session.persona,
            status: { in: ['PASSED', 'FAILED'] },
          },
          orderBy: { startedAt: 'asc' },
          select: { status: true },
        });
        await prisma.testSession.update({
          where: { id: session.id },
          data: { flakinessScore: computeFlakinessScore(history.map((h) => h.status)) },
        });

        if (data.status === 'FAILED') void runDiagnostics(session.id);

        io.emit(SocketEvents.sessionUpdate(session.id), { type: 'session-completed', data });
      } catch (err) {
        console.error('[agent] failed to complete session:', err);
      }
    });
  });

  async function runDiagnostics(sessionId: string) {
    try {
      const session = await prisma.testSession.findUnique({
        where: { id: sessionId },
        include: { steps: { orderBy: { stepNumber: 'asc' }, include: { networkLogs: true } } },
      });
      if (!session) return;
      const diagnostics = await ai.generateDiagnosticsReport(session);
      io.emit(SocketEvents.sessionUpdate(sessionId), {
        type: 'diagnostics-ready',
        data: { diagnostics },
      });
    } catch (err) {
      console.error('[ai] diagnostics failed:', err);
    }
  }

  // ------------------------------------------------------------------- REST
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, llm: ai.describe() });
  });

  app.get('/api/projects', async (_req, res) => {
    const projects = await prisma.project.findMany({
      include: {
        sessions: { orderBy: { startedAt: 'desc' }, take: 5 },
        _count: { select: { sessions: true, endpoints: true } },
      },
    });
    res.json(projects.map((p) => ({ ...p, agentOnline: connectedAgents.has(p.id) })));
  });

  app.post('/api/projects', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 200) {
      res.status(400).json({ error: 'Project name is required (max 200 characters)' });
      return;
    }
    const project = await prisma.project.create({ data: { name } });
    res.status(201).json(project);
  });

  app.get('/api/projects/:id', async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        sessions: { orderBy: { startedAt: 'desc' } },
        endpoints: { orderBy: { avgLatencyMs: 'desc' } },
      },
    });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json({ ...project, agentOnline: connectedAgents.has(project.id) });
  });

  app.get('/api/sessions/:id', async (req, res) => {
    const session = await prisma.testSession.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepNumber: 'asc' }, include: { networkLogs: true } } },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  app.post('/api/sessions', async (req, res) => {
    const { projectId, targetUrl, persona, goal } = req.body ?? {};
    if (typeof projectId !== 'string' || !projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }
    const agentSocket = connectedAgents.get(projectId);
    if (!agentSocket) {
      res.status(409).json({
        error:
          'No runner agent is online for this project. Start one with: pnpm --filter @ghostiq/runner start -k <projectId>',
      });
      return;
    }

    const command = RunTestCommand.omit({ sessionId: true }).safeParse({
      targetUrl,
      persona,
      goal: typeof goal === 'string' && goal.trim() ? goal : DEFAULT_GOAL,
    });
    if (!command.success) {
      res.status(400).json({ error: 'Invalid run request', issues: command.error.issues });
      return;
    }

    const session = await prisma.testSession.create({
      data: {
        projectId,
        name: `Run: ${command.data.persona} - ${new Date().toISOString()}`,
        targetUrl: command.data.targetUrl,
        persona: command.data.persona,
        status: 'RUNNING',
      },
    });

    agentSocket.emit(SocketEvents.runTest, { sessionId: session.id, ...command.data });
    res.status(201).json(session);
  });

  // Called by the runner. Unauthenticated until Phase 7 (API keys).
  app.post('/api/ai/plan-step', async (req, res) => {
    const { htmlSnapshot, currentUrl, history, goal, persona } = req.body ?? {};
    const next = await ai.planNextAction(
      String(htmlSnapshot ?? ''),
      String(currentUrl ?? ''),
      Array.isArray(history) ? history : [],
      String(goal ?? ''),
      String(persona ?? ''),
    );
    res.json(next);
  });

  app.post('/api/ai/heal-selector', async (req, res) => {
    const { failedSelector, htmlSnapshot, goal, persona } = req.body ?? {};
    const healed = await ai.healSelector(
      String(failedSelector ?? ''),
      String(htmlSnapshot ?? ''),
      String(goal ?? ''),
      String(persona ?? ''),
    );
    res.json(healed);
  });

  app.post('/api/sessions/:id/set-baseline', async (req, res) => {
    const session = await prisma.testSession.findUnique({ where: { id: req.params.id } });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await prisma.testSession.updateMany({
      where: {
        projectId: session.projectId,
        targetUrl: session.targetUrl,
        persona: session.persona,
      },
      data: { isBaseline: false },
    });
    const updated = await prisma.testSession.update({
      where: { id: session.id },
      data: { isBaseline: true },
    });
    res.json(updated);
  });

  app.get('/api/projects/:id/baseline', async (req, res) => {
    const { targetUrl, persona } = req.query;
    if (typeof targetUrl !== 'string' || typeof persona !== 'string') {
      res.status(400).json({ error: 'targetUrl and persona are required' });
      return;
    }
    const baseline = await prisma.testSession.findFirst({
      where: { projectId: req.params.id, targetUrl, persona, isBaseline: true },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    res.json(baseline);
  });

  // Produces a PR-comment preview. Real GitHub integration arrives in Phase 6.
  app.post('/api/projects/:id/export-pr', async (req, res) => {
    const { repo, prNumber } = req.body ?? {};
    const pr = Number.parseInt(String(prNumber), 10);
    if (typeof repo !== 'string' || !repo || !Number.isFinite(pr)) {
      res.status(400).json({ error: 'repo and prNumber are required' });
      return;
    }
    const project = await prisma.project.update({
      where: { id: req.params.id },
      data: { githubRepo: repo, githubPrNumber: pr },
    });
    const latest = await prisma.testSession.findFirst({
      where: { projectId: req.params.id },
      orderBy: { startedAt: 'desc' },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });

    const icon = latest?.status === 'PASSED' ? '✅' : '❌';
    const steps =
      latest?.steps
        .map((s) => `- Step ${s.stepNumber} [${s.status}]: ${s.description}`)
        .join('\n') ?? 'No steps executed.';
    const comment = [
      '### 👻 GhostIQ Autonomous Test Report',
      '',
      `**Repo**: \`${repo}\` | **PR**: \`#${pr}\``,
      `**Status**: ${icon} **${latest?.status ?? 'UNKNOWN'}**`,
      `**Target URL**: \`${latest?.targetUrl ?? 'N/A'}\``,
      `**Persona**: \`${latest?.persona ?? 'N/A'}\``,
      '',
      '#### Summary of Test Run:',
      steps,
    ].join('\n');

    res.json({ success: true, comment, project });
  });

  // Production: serve the built dashboard from the same origin.
  if (env.GHOSTIQ_DASHBOARD_DIR && fs.existsSync(env.GHOSTIQ_DASHBOARD_DIR)) {
    const dashboardDir = path.resolve(env.GHOSTIQ_DASHBOARD_DIR);
    app.use(express.static(dashboardDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, server, io };
}

function logInvalid(event: string, error: { issues: unknown[] }) {
  console.warn(
    `[agent] rejected invalid "${event}" payload:`,
    JSON.stringify(error.issues).slice(0, 500),
  );
}
