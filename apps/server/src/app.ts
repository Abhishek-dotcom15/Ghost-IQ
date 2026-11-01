import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import { LlmError } from '@ghostiq/llm';
import {
  NextActionRequest,
  RunConfig,
  SessionCompletedEvent,
  SocketEvents,
  StepCompletedEvent,
  StepStartedEvent,
  normalizeEndpointUrl,
  toOrigin,
  type NetworkRequestRecord,
  type RunTestCommand,
} from '@ghostiq/shared';
import { z } from 'zod';
import type { PrismaClient } from './db.js';
import type { Env } from './env.js';
import { computeFlakinessScore, updateRunningAverage } from './lib/flakiness.js';
import { describeLlm, type LlmRuntime } from './llm.js';
import type { AiService } from './services/ai.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  ai: AiService;
  llm: LlmRuntime;
}

export interface GhostIqApp {
  app: Express;
  server: http.Server;
  io: Server;
}

const DEFAULT_GOAL = 'Explore the app like the persona would and try its main flows.';

/** What a client may send to start a run. Everything except the target has a default. */
export const StartRunBody = z.object({
  projectId: z.string().min(1),
  targetUrl: z.url(),
  persona: z.string().min(1).max(100),
  goal: z.string().max(2000).optional(),
  budgets: z
    .object({
      maxSteps: z.number().int().optional(),
      maxDurationMs: z.number().int().optional(),
      maxTokens: z.number().int().optional(),
    })
    .optional(),
  /** Extra origins besides the target's own, e.g. an auth domain. */
  allowedOrigins: z.array(z.string()).max(19).optional(),
  allowDestructive: z.boolean().optional(),
});
export type StartRunBody = z.infer<typeof StartRunBody>;

/** Builds the run config: the target's origin is always allowed, budgets get defaults. */
export function buildRunConfig(body: StartRunBody): RunConfig {
  const targetOrigin = new URL(body.targetUrl).origin;
  const extra = (body.allowedOrigins ?? []).map((o) => toOrigin(o)).filter((o): o is string => !!o);
  return RunConfig.parse({
    budgets: body.budgets ?? {},
    allowedOrigins: [...new Set([targetOrigin, ...extra])],
    allowDestructive: body.allowDestructive ?? false,
  });
}

/**
 * Builds the HTTP server, Express app and Socket.IO hub without listening,
 * so tests can drive it with supertest.
 */
export function createApp({ env, prisma, ai, llm }: AppDeps): GhostIqApp {
  const corsOrigins = env.GHOSTIQ_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1.5e7, // screenshots travel as base64 inside step events
  });

  const screenshotsDir = path.resolve(env.GHOSTIQ_SCREENSHOT_DIR);
  const artifactsDir = path.resolve(env.GHOSTIQ_ARTIFACT_DIR);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  app.disable('x-powered-by');
  app.use(cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/screenshots', express.static(screenshotsDir, { fallthrough: false }));
  app.use('/artifacts', express.static(artifactsDir, { fallthrough: false }));

  // projectId -> connected runner socket; sessionId -> socket executing it
  const connectedAgents = new Map<string, Socket>();
  const activeRuns = new Map<string, Socket>();

  const pushUpdate = (sessionId: string, type: string, data: unknown) =>
    io.emit(SocketEvents.sessionUpdate(sessionId), { type, data });

  // ---------------------------------------------------------------- sockets
  io.on('connection', (socket) => {
    const { role, projectId } = socket.handshake.query;
    if (role !== 'agent' || typeof projectId !== 'string' || !projectId) return;

    connectedAgents.set(projectId, socket);
    console.log(`[agent] connected for project ${projectId}`);
    io.emit(SocketEvents.agentStatusChange, { projectId, status: 'online' });

    socket.on('disconnect', async () => {
      if (connectedAgents.get(projectId) === socket) connectedAgents.delete(projectId);
      io.emit(SocketEvents.agentStatusChange, { projectId, status: 'offline' });
      // Runs this runner was executing can never finish now.
      for (const [sessionId, owner] of activeRuns) {
        if (owner !== socket) continue;
        activeRuns.delete(sessionId);
        const summary = 'The runner disconnected before the run finished.';
        await prisma.testSession
          .updateMany({
            where: { id: sessionId, status: 'RUNNING' },
            data: {
              status: 'FAILED',
              endReason: 'runner_disconnected',
              summary,
              endedAt: new Date(),
            },
          })
          .catch((err: unknown) => console.error('[agent] failed to close orphaned run:', err));
        pushUpdate(sessionId, 'session-completed', {
          sessionId,
          status: 'FAILED',
          endReason: 'runner_disconnected',
          summary,
        });
      }
    });

    socket.on(SocketEvents.stepStarted, (raw: unknown) => {
      const parsed = StepStartedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.stepStarted, parsed.error);
      if (activeRuns.get(parsed.data.sessionId) !== socket) return;
      pushUpdate(parsed.data.sessionId, 'step-started', parsed.data);
    });

    socket.on(SocketEvents.stepCompleted, async (raw: unknown) => {
      const parsed = StepCompletedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.stepCompleted, parsed.error);
      const data = parsed.data;
      if (activeRuns.get(data.sessionId) !== socket) return;

      try {
        const session = await prisma.testSession.findUnique({ where: { id: data.sessionId } });
        if (!session || session.projectId !== projectId) return;

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
            actionJson: data.agentAction ? JSON.stringify(data.agentAction) : null,
            locatorJson: data.locator ? JSON.stringify(data.locator) : null,
            url: data.url ?? null,
            durationMs: data.durationMs ?? null,
            observationHash: data.observationHash ?? null,
            issuesJson: data.issues.length ? JSON.stringify(data.issues) : null,
          },
        });

        await recordNetwork(prisma, session.projectId, step.id, data.networkRequests);
        pushUpdate(session.id, 'step-completed', { ...step, networkLogs: data.networkRequests });
      } catch (err) {
        console.error('[agent] failed to persist step:', err);
      }
    });

    socket.on(SocketEvents.sessionCompleted, async (raw: unknown) => {
      const parsed = SessionCompletedEvent.safeParse(raw);
      if (!parsed.success) return logInvalid(SocketEvents.sessionCompleted, parsed.error);
      const data = parsed.data;
      if (activeRuns.get(data.sessionId) !== socket) return;
      activeRuns.delete(data.sessionId);

      try {
        const session = await prisma.testSession.findUnique({ where: { id: data.sessionId } });
        if (!session || session.projectId !== projectId) return;

        await prisma.testSession.update({
          where: { id: session.id },
          data: {
            status: data.status,
            endReason: data.endReason,
            summary: data.summary,
            endedAt: new Date(),
          },
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
        pushUpdate(session.id, 'session-completed', data);
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
      pushUpdate(sessionId, 'diagnostics-ready', { diagnostics });
    } catch (err) {
      console.error('[ai] diagnostics failed:', err);
    }
  }

  // ------------------------------------------------------------------- REST
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, llm: describeLlm(llm) });
  });

  /** LLM configuration, last health check and spend (all time and last 24 hours). */
  app.get('/api/llm/status', async (_req, res) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [allTime, last24h] = await Promise.all([
      llmUsage(prisma, {}),
      llmUsage(prisma, { createdAt: { gte: since } }),
    ]);
    res.json({ ...describeLlm(llm), usage: { allTime, last24h } });
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
    res.json({ ...session, llmUsage: await llmUsage(prisma, { sessionId: session.id }) });
  });

  app.post('/api/sessions', async (req, res) => {
    const body = StartRunBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid run request', issues: body.error.issues });
      return;
    }
    let config: RunConfig;
    try {
      config = buildRunConfig(body.data);
    } catch (err) {
      res.status(400).json({ error: `Invalid run configuration: ${(err as Error).message}` });
      return;
    }

    const project = await prisma.project.findUnique({ where: { id: body.data.projectId } });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const agentSocket = connectedAgents.get(project.id);
    if (!agentSocket) {
      res.status(409).json({
        error: `No runner agent is online for this project. Start one with: pnpm --filter @ghostiq/runner start -k ${project.id}`,
      });
      return;
    }

    const goal = body.data.goal?.trim() || DEFAULT_GOAL;
    const session = await prisma.testSession.create({
      data: {
        projectId: project.id,
        name: `${body.data.persona}: ${goal.slice(0, 80)}`,
        targetUrl: body.data.targetUrl,
        persona: body.data.persona,
        goal,
        configJson: JSON.stringify(config),
        status: 'RUNNING',
      },
    });

    const command: RunTestCommand = {
      sessionId: session.id,
      targetUrl: body.data.targetUrl,
      persona: body.data.persona,
      goal,
      config,
    };
    activeRuns.set(session.id, agentSocket);
    agentSocket.emit(SocketEvents.runStart, command);
    res.status(201).json(session);
  });

  app.post('/api/sessions/:id/cancel', async (req, res) => {
    const session = await prisma.testSession.findUnique({ where: { id: req.params.id } });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runner = activeRuns.get(session.id);
    if (session.status !== 'RUNNING' || !runner) {
      res.status(409).json({ error: 'This run is not in progress.' });
      return;
    }
    runner.emit(SocketEvents.runCancel, { sessionId: session.id });
    res.status(202).json({ ok: true });
  });

  /** Playwright trace upload from the runner (zip). */
  app.put(
    '/api/sessions/:id/trace',
    express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '200mb' }),
    async (req, res) => {
      const session = await prisma.testSession.findUnique({ where: { id: String(req.params.id) } });
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Expected a zip body' });
        return;
      }
      const dir = path.join(artifactsDir, session.id);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'trace.zip'), req.body);
      const traceUrl = `/artifacts/${session.id}/trace.zip`;
      await prisma.testSession.update({ where: { id: session.id }, data: { traceUrl } });
      pushUpdate(session.id, 'trace-ready', { traceUrl });
      res.status(201).json({ traceUrl });
    },
  );

  /** The agent's planner. Called by the runner once per step; keys stay on the server. */
  app.post('/api/ai/next-action', async (req, res) => {
    const parsed = NextActionRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { kind: 'bad_request', message: parsed.error.message } });
      return;
    }
    try {
      res.json(await ai.nextAction(parsed.data));
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('unknown', String(err));
      res.status(502).json({ error: { kind: e.kind, message: e.message } });
    }
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
      `**Status**: ${icon} **${latest?.status ?? 'UNKNOWN'}**${latest?.endReason ? ` (${latest.endReason})` : ''}`,
      `**Target URL**: \`${latest?.targetUrl ?? 'N/A'}\``,
      `**Persona**: \`${latest?.persona ?? 'N/A'}\``,
      latest?.summary ? `**Summary**: ${latest.summary}` : '',
      '',
      '#### Steps',
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
    if (isPayloadTooLarge(err)) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, server, io };
}

/** Stores raw requests and folds them into per-endpoint health. */
async function recordNetwork(
  prisma: PrismaClient,
  projectId: string,
  stepId: string,
  requests: NetworkRequestRecord[],
) {
  for (const req of requests) {
    await prisma.networkRequest.create({
      data: {
        stepId,
        url: req.url,
        method: req.method,
        status: req.status,
        latencyMs: req.latencyMs,
      },
    });

    const url = normalizeEndpointUrl(req.url);
    const isError = req.status >= 400 || req.status === 0;
    const key = { projectId_url_method: { projectId, url, method: req.method } };
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
          projectId,
          url,
          method: req.method,
          callCount: 1,
          errorCount: isError ? 1 : 0,
          avgLatencyMs: req.latencyMs,
        },
      });
    }
  }
}

/** Aggregated LLM spend for a set of calls. `costUsd` excludes calls to unpriced models. */
export async function llmUsage(
  prisma: PrismaClient,
  where: { sessionId?: string; createdAt?: { gte: Date } },
) {
  const [totals, failedCalls, fallbackCalls, cacheHits, unpricedCalls] = await Promise.all([
    prisma.llmCall.aggregate({
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costUsd: true, latencyMs: true },
    }),
    prisma.llmCall.count({ where: { ...where, ok: false } }),
    prisma.llmCall.count({ where: { ...where, fallbackUsed: true } }),
    prisma.llmCall.count({ where: { ...where, cacheHit: true } }),
    prisma.llmCall.count({ where: { ...where, costUsd: null } }),
  ]);
  return {
    calls: totals._count._all,
    failedCalls,
    fallbackCalls,
    cacheHits,
    unpricedCalls,
    tokensIn: totals._sum.tokensIn ?? 0,
    tokensOut: totals._sum.tokensOut ?? 0,
    costUsd: totals._sum.costUsd ?? 0,
    latencyMs: totals._sum.latencyMs ?? 0,
  };
}

function isPayloadTooLarge(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.too.large'
  );
}

function logInvalid(event: string, error: { issues: unknown[] }) {
  console.warn(
    `[agent] rejected invalid "${event}" payload:`,
    JSON.stringify(error.issues).slice(0, 500),
  );
}
