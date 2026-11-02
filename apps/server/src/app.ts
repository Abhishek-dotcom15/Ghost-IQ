import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import { LlmError } from '@ghostiq/llm';
import {
  HealLocatorRequest,
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
import { rateLimitEnabled, type Env } from './env.js';
import { FindingsEngine, type FindingChange } from './findings/engine.js';
import { registerFindingRoutes } from './findings/routes.js';
import { registerExportRoutes } from './export/routes.js';
import { registerAnalyticsRoutes } from './analytics/routes.js';
import { updateRunningAverage } from './lib/flakiness.js';
import { ReplayService, registerReplayRoutes } from './replay/service.js';
import { buildPayload, sendWebhook } from './notify/webhook.js';
import { authorize, can, sameOriginForCookieWrites, visibleProjectIds } from './auth/access.js';
import { AuditLog } from './auth/audit.js';
import { auditTrail } from './auth/audit-trail.js';
import { Authenticator, type Principal } from './auth/principal.js';
import { registerAuthRoutes } from './auth/routes.js';
import { securityHeaders } from './security/headers.js';
import { RateLimiter, rateLimit } from './security/rate-limit.js';
import { BlockedTargetError, assertPublicUrl, parseAllowedHosts } from './security/ssrf.js';
import { describeLlm, type LlmRuntime } from './llm.js';
import type { AiService } from './services/ai.js';
import {
  PersonaConflictError,
  PersonaValidationError,
  type PersonaRecord,
  type PersonaRegistry,
} from './services/personas.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  ai: AiService;
  llm: LlmRuntime;
  personas: PersonaRegistry;
  /** Outbound HTTP for GitHub sign-in (tests inject a fake). */
  fetch?: typeof fetch;
}

/** Persona as returned by the API (spec included for the builder and launch form). */
function personaView(p: PersonaRecord) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    source: p.source,
    editable: p.editable,
    version: p.version,
    yaml: p.yaml,
    spec: p.spec,
  };
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
  personaId: z.string().min(1).max(60),
  /** Overrides the persona's seed, e.g. to reproduce a previous run exactly. */
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .optional(),
  /** Required for personas marked requires_consent (e.g. security probing). */
  consent: z.boolean().optional(),
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
export function createApp({
  env,
  prisma,
  ai,
  llm,
  personas,
  fetch: fetchImpl,
}: AppDeps): GhostIqApp {
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
  const findings = new FindingsEngine(prisma, {
    screenshots: screenshotsDir,
    artifacts: artifactsDir,
  });

  const auth = new Authenticator(prisma, env);
  const audit = new AuditLog(prisma);
  const limiter = new RateLimiter();
  const ssrf = { allowedHosts: parseAllowedHosts(env.GHOSTIQ_ALLOWED_TARGETS) };

  // Events go to the project's room only: dashboards join rooms of projects they may read.
  const room = (projectId: string) => `project:${projectId}`;
  const emitProject = (projectId: string, event: string, data: unknown) =>
    io.to(room(projectId)).emit(event, data);
  const pushUpdate = (projectId: string, sessionId: string, type: string, data: unknown) =>
    emitProject(projectId, SocketEvents.sessionUpdate(sessionId), { type, data });

  /** Live updates: the run view refreshes its findings, the inbox shows new ones. */
  const announceFindings = (sessionId: string, projectId: string, changes: FindingChange[]) => {
    pushUpdate(projectId, sessionId, 'findings-updated', { count: changes.length });
    emitProject(projectId, 'findings-updated', {
      projectId,
      newFindings: changes.filter((c) => c.isNew).length,
      regressed: changes.filter((c) => c.regressed).length,
    });
  };
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  app.disable('x-powered-by');
  if (env.GHOSTIQ_TRUST_PROXY) app.set('trust proxy', env.GHOSTIQ_TRUST_PROXY);
  app.use(securityHeaders({ https: (env.GHOSTIQ_PUBLIC_URL ?? '').startsWith('https://') }));
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(sameOriginForCookieWrites(corsOrigins));
  app.use(authorize(prisma, auth));
  if (rateLimitEnabled(env)) app.use(rateLimit(limiter));
  app.use(auditTrail(audit));
  app.use('/screenshots', express.static(screenshotsDir, { fallthrough: false }));
  app.use('/artifacts', express.static(artifactsDir, { fallthrough: false }));
  registerAuthRoutes(app, { prisma, env, auth, audit, fetch: fetchImpl });

  // projectId -> connected runner socket; sessionId -> socket executing it
  const connectedAgents = new Map<string, Socket>();
  const activeRuns = new Map<string, Socket>();

  /** Hands a run to the project's runner; false when none is connected. */
  const dispatch = (projectId: string, command: RunTestCommand): boolean => {
    const socket = connectedAgents.get(projectId);
    if (!socket) return false;
    activeRuns.set(command.sessionId, socket);
    socket.emit(SocketEvents.runStart, command);
    return true;
  };
  const replays = new ReplayService(prisma, {
    dispatch,
    online: (projectId) => connectedAgents.has(projectId),
    notify: (event, data) => emitProject((data as { projectId: string }).projectId, event, data),
  });
  void replays
    .resetLegacyFlakiness()
    .catch((err: unknown) => console.error('[replay] flakiness cleanup failed:', err));

  // ---------------------------------------------------------------- sockets
  // Every socket is authenticated at the handshake: runners with a project API key
  // (auth.token), dashboards with their session cookie.
  io.use(async (socket, next) => {
    try {
      const principal = await auth.fromHeaders(
        socket.handshake.headers,
        socket.handshake.auth?.token,
      );
      socket.data.principal = principal;
      const { role, projectId } = socket.handshake.query;
      if (role === 'agent') {
        if (typeof projectId !== 'string' || !projectId)
          return next(new Error('projectId is required'));
        if (auth.enabled && !(await can(prisma, principal, projectId, 'write'))) {
          await audit.record(
            principal,
            { action: 'runner.denied', projectId },
            socket.handshake.address,
          );
          return next(new Error('Unauthorized: a valid API key for this project is required'));
        }
      }
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on('connection', (socket) => {
    const principal = socket.data.principal as Principal;
    const { role, projectId } = socket.handshake.query;
    if (role !== 'agent' || typeof projectId !== 'string' || !projectId) {
      // Dashboard: receives events of the projects it subscribes to (and may read).
      socket.on('subscribe', async (raw: unknown) => {
        const pid = typeof raw === 'string' ? raw : (raw as { projectId?: unknown })?.projectId;
        if (typeof pid !== 'string' || !pid) return;
        if (auth.enabled && !(await can(prisma, principal, pid, 'read'))) return;
        for (const r of socket.rooms) if (r.startsWith('project:')) void socket.leave(r);
        void socket.join(room(pid));
      });
      return;
    }

    connectedAgents.set(projectId, socket);
    console.log(`[agent] connected for project ${projectId}`);
    emitProject(projectId, SocketEvents.agentStatusChange, { projectId, status: 'online' });

    socket.on('disconnect', async () => {
      if (connectedAgents.get(projectId) === socket) connectedAgents.delete(projectId);
      emitProject(projectId, SocketEvents.agentStatusChange, { projectId, status: 'offline' });
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
        pushUpdate(projectId, sessionId, 'session-completed', {
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
      pushUpdate(projectId, parsed.data.sessionId, 'step-started', parsed.data);
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
            behavior: data.behavior ?? null,
            inputJson: data.input ? JSON.stringify(data.input) : null,
            healed: !!data.heal,
          },
        });
        if (data.heal) await replays.recordHeal(session, data, screenshotUrl);

        await recordNetwork(prisma, session.projectId, step.id, data.networkRequests);
        pushUpdate(session.projectId, session.id, 'step-completed', {
          ...step,
          networkLogs: data.networkRequests,
        });

        const changes = await findings.recordStep(
          { id: session.id, projectId: session.projectId, persona: session.persona },
          { stepNumber: step.stepNumber, url: step.url, screenshotPath: step.screenshotPath },
          data.issues,
        );
        if (changes.length) announceFindings(session.id, session.projectId, changes);
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
            finalStateJson: data.finalState ? JSON.stringify(data.finalState) : null,
            endedAt: new Date(),
          },
        });

        // Flakiness is measured on replays only (explore runs vary with the model, not the app).
        await replays.onSessionFinished(session);

        const persona = session.personaId ? await personas.get(session.personaId) : null;
        const runLevel = await findings.finalizeSession(session.id, {
          throttled: (persona?.spec.network ?? 'none') !== 'none',
        });
        if (runLevel.length) announceFindings(session.id, session.projectId, runLevel);

        if (env.GHOSTIQ_WEBHOOK_URL) void notifyRunCompleted(session.id);

        // A failed replay already says what diverged; no model call needed.
        if (data.status === 'FAILED' && session.mode !== 'replay') void runDiagnostics(session.id);
        pushUpdate(session.projectId, session.id, 'session-completed', data);
      } catch (err) {
        console.error('[agent] failed to complete session:', err);
      }
    });
  });

  /** Outbound notification (generic JSON or Slack). Failures are logged, never thrown. */
  async function notifyRunCompleted(sessionId: string) {
    try {
      const session = await prisma.testSession.findUnique({
        where: { id: sessionId },
        include: { project: { select: { id: true, name: true } } },
      });
      if (!session || !env.GHOSTIQ_WEBHOOK_URL) return;
      const rows = await prisma.finding.findMany({
        where: { occurrences: { some: { sessionId } }, status: { in: ['open', 'confirmed'] } },
        select: { severity: true, title: true, route: true },
      });
      const result = await sendWebhook(
        buildPayload({
          project: session.project,
          session,
          findings: rows,
          publicUrl: env.GHOSTIQ_PUBLIC_URL,
        }),
        { url: env.GHOSTIQ_WEBHOOK_URL, minSeverity: env.GHOSTIQ_WEBHOOK_MIN_SEVERITY },
      );
      if (result.error || (result.status && !result.sent)) {
        console.error(`[webhook] delivery failed: ${result.error ?? `HTTP ${result.status}`}`);
      }
    } catch (err) {
      console.error('[webhook] failed:', err);
    }
  }

  async function runDiagnostics(sessionId: string) {
    try {
      const session = await prisma.testSession.findUnique({
        where: { id: sessionId },
        include: { steps: { orderBy: { stepNumber: 'asc' }, include: { networkLogs: true } } },
      });
      if (!session) return;
      const diagnostics = await ai.generateDiagnosticsReport(session);
      pushUpdate(session.projectId, sessionId, 'diagnostics-ready', { diagnostics });
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

  app.get('/api/projects', async (req, res) => {
    const visible = await visibleProjectIds(prisma, req.principal ?? { kind: 'anonymous' });
    const projects = await prisma.project.findMany({
      where: visible ? { id: { in: visible } } : undefined,
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
    const principal = req.principal ?? { kind: 'anonymous' as const };
    const project = await prisma.project.create({
      data: {
        name,
        // The creator owns the project.
        ...(principal.kind === 'user'
          ? { members: { create: { userId: principal.user.id, role: 'owner' } } }
          : {}),
      },
    });
    await audit.fromRequest(req, {
      action: 'project.create',
      projectId: project.id,
      metadata: { name },
    });
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
    if (env.GHOSTIQ_HOSTED) {
      // The runner browses every allowed origin: all of them must be public.
      try {
        for (const origin of [body.data.targetUrl, ...config.allowedOrigins])
          await assertPublicUrl(origin, ssrf);
      } catch (err) {
        if (!(err instanceof BlockedTargetError)) throw err;
        await audit.fromRequest(req, {
          action: 'run.blocked_target',
          projectId: body.data.projectId,
          target: body.data.targetUrl,
          metadata: { reason: err.message },
        });
        res.status(400).json({ error: err.message });
        return;
      }
    }

    const project = await prisma.project.findUnique({ where: { id: body.data.projectId } });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const persona = await personas.get(body.data.personaId);
    if (!persona) {
      res.status(404).json({ error: `Persona "${body.data.personaId}" not found` });
      return;
    }
    if (persona.spec.requires_consent && body.data.consent !== true) {
      res.status(400).json({
        error: `The ${persona.name} persona needs explicit consent: confirm you own or are authorised to test ${body.data.targetUrl}.`,
        requiresConsent: true,
      });
      return;
    }
    if (!connectedAgents.has(project.id)) {
      res.status(409).json({
        error: `No runner agent is online for this project. Start one with: pnpm --filter @ghostiq/runner start -k ${project.id}`,
      });
      return;
    }

    const goal = body.data.goal?.trim() || persona.spec.goals[0] || DEFAULT_GOAL;
    const seed = body.data.seed ?? persona.spec.seed;
    const session = await prisma.testSession.create({
      data: {
        projectId: project.id,
        name: `${persona.name}: ${goal.slice(0, 80)}`,
        targetUrl: body.data.targetUrl,
        persona: persona.name,
        personaId: persona.id,
        personaJson: JSON.stringify(persona.spec),
        seed,
        goal,
        configJson: JSON.stringify(config),
        status: 'RUNNING',
      },
    });

    const command: RunTestCommand = {
      sessionId: session.id,
      targetUrl: body.data.targetUrl,
      persona: persona.spec,
      seed,
      goal,
      config,
    };
    dispatch(project.id, command);
    res.status(201).json(session);
  });

  // ---------------------------------------------------------------- personas
  const yamlBody = (body: unknown): string | null =>
    typeof (body as { yaml?: unknown })?.yaml === 'string' ? (body as { yaml: string }).yaml : null;

  const personaError = (res: Response, err: unknown) => {
    if (err instanceof PersonaValidationError) {
      res.status(400).json({ error: 'Invalid persona', errors: err.errors });
    } else if (err instanceof PersonaConflictError) {
      res.status(409).json({ error: err.message });
    } else {
      throw err;
    }
  };

  app.get('/api/personas', async (_req, res) => {
    res.json((await personas.list()).map(personaView));
  });

  app.get('/api/personas/:id', async (req, res) => {
    const persona = await personas.get(req.params.id);
    if (!persona) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }
    res.json(personaView(persona));
  });

  /** Dry run for the Persona Builder: validate YAML and preview generated inputs. */
  app.post('/api/personas/validate', (req, res) => {
    const yaml = yamlBody(req.body);
    if (yaml === null) {
      res.status(400).json({ error: 'Send { "yaml": "..." }' });
      return;
    }
    res.json(personas.validate(yaml));
  });

  app.post('/api/personas', async (req, res) => {
    const yaml = yamlBody(req.body);
    if (yaml === null) {
      res.status(400).json({ error: 'Send { "yaml": "..." }' });
      return;
    }
    try {
      res.status(201).json(personaView(await personas.create(yaml)));
    } catch (err) {
      personaError(res, err);
    }
  });

  app.put('/api/personas/:id', async (req, res) => {
    const yaml = yamlBody(req.body);
    if (yaml === null) {
      res.status(400).json({ error: 'Send { "yaml": "..." }' });
      return;
    }
    try {
      const updated = await personas.update(req.params.id, yaml);
      if (!updated) {
        res.status(404).json({ error: 'Persona not found' });
        return;
      }
      res.json(personaView(updated));
    } catch (err) {
      personaError(res, err);
    }
  });

  app.delete('/api/personas/:id', async (req, res) => {
    try {
      const deleted = await personas.delete(req.params.id);
      res.status(deleted ? 204 : 404).end();
    } catch (err) {
      personaError(res, err);
    }
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
      pushUpdate(session.projectId, session.id, 'trace-ready', { traceUrl });
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

  /** Heal ladder, model rung (replays only). */
  app.post('/api/ai/heal-locator', async (req, res) => {
    const parsed = HealLocatorRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { kind: 'bad_request', message: parsed.error.message } });
      return;
    }
    try {
      res.json(await ai.healLocator(parsed.data));
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
    // Its page screenshots become the reference for visual regression.
    const baselineImages = await findings.captureBaseline(session.id);
    res.json({ ...updated, baselineImages });
  });

  registerFindingRoutes(app, prisma);
  registerExportRoutes(app, prisma);
  registerReplayRoutes(app, prisma, replays);
  registerAnalyticsRoutes(app, prisma);

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

  // Unknown API routes are JSON 404s, never the dashboard's index.html.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Production: serve the built dashboard from the same origin.
  if (env.GHOSTIQ_DASHBOARD_DIR && fs.existsSync(env.GHOSTIQ_DASHBOARD_DIR)) {
    const dashboardDir = path.resolve(env.GHOSTIQ_DASHBOARD_DIR);
    app.use(express.static(dashboardDir));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
  }

  // Express 5 forwards rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isPayloadTooLarge(err)) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    // Client errors raised by middleware: malformed JSON (400), missing static file (404), ...
    const status = clientErrorStatus(err);
    if (status) {
      const message = { 403: 'Forbidden', 404: 'Not found' }[status] ?? 'Bad request';
      res.status(status).json({ error: message });
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

/** 4xx status carried by a middleware error (body-parser, serve-static), if any. */
export function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return status;
  if (e.code === 'ENOENT') return 404;
  return null;
}

function logInvalid(event: string, error: { issues: unknown[] }) {
  console.warn(
    `[agent] rejected invalid "${event}" payload:`,
    JSON.stringify(error.issues).slice(0, 500),
  );
}
