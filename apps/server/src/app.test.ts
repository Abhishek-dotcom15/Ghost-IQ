import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SocketEvents, type RunTestCommand } from '@ghostiq/shared';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRunConfig, createApp } from './app.js';
import { createPrismaClient, type PrismaClient } from './db.js';
import { loadEnv } from './env.js';
import { createLlmRuntime } from './llm.js';
import { AiService } from './services/ai.js';

// Integration tests against a real throwaway SQLite database and a real Socket.IO server.
// The schema is pushed once by the vitest global setup (see vitest.config.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-test-'));
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  GHOSTIQ_SCREENSHOT_DIR: path.join(tmp, 'screenshots'),
  GHOSTIQ_ARTIFACT_DIR: path.join(tmp, 'artifacts'),
  GHOSTIQ_LLM_PROVIDER: 'mock',
});

let prisma: PrismaClient;
let built: ReturnType<typeof createApp>;
let app: ReturnType<typeof createApp>['app'];
let baseUrl: string;

beforeAll(async () => {
  prisma = createPrismaClient(env.DATABASE_URL);
  const llm = createLlmRuntime(env, prisma);
  built = createApp({ env, prisma, ai: new AiService(llm.client), llm });
  app = built.app;
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  baseUrl = `http://localhost:${(built.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await built.io.close();
  await prisma.$disconnect();
});

const LOGIN_SNAPSHOT = `- heading "App Secure Login" [level=2] [ref=e6]
- textbox "Email address" [ref=e9]
- textbox "Password" [ref=e11]
- button "Sign In" [ref=e12] [cursor=pointer]`;

function nextActionBody(sessionId: string, history: unknown[] = []) {
  return {
    sessionId,
    goal: 'Log in',
    persona: 'Happy Path User',
    url: 'http://localhost:3000/',
    title: 'App',
    snapshot: LOGIN_SNAPSHOT,
    history,
    stepNumber: history.length + 2,
    allowDestructive: false,
  };
}

/** Connects a fake runner agent and resolves once the server has registered it. */
async function connectAgent(projectId: string): Promise<Socket> {
  const socket = connect(baseUrl, {
    query: { role: 'agent', projectId },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/projects/${projectId}`);
    if (res.body.agentOnline) return socket;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('agent did not register');
}

async function waitFor<T>(check: () => Promise<T | undefined | null | false>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

describe('GhostIQ API', () => {
  it('reports health and labels demo mode', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      llm: {
        mode: 'demo',
        provider: 'mock',
        model: 'demo',
        demoReason: 'GHOSTIQ_LLM_PROVIDER=mock',
      },
    });
  });

  it('creates and lists projects', async () => {
    const created = await request(app).post('/api/projects').send({ name: 'Shop' });
    expect(created.status).toBe(201);
    const list = await request(app).get('/api/projects');
    expect(list.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Shop', agentOnline: false })]),
    );
  });

  it('rejects a project without a name', async () => {
    expect((await request(app).post('/api/projects').send({})).status).toBe(400);
  });

  it('validates run requests and requires an online runner', async () => {
    const project = await request(app).post('/api/projects').send({ name: 'Offline' });
    const base = {
      projectId: project.body.id,
      targetUrl: 'http://localhost:3000',
      persona: 'Happy Path User',
    };

    expect(
      (
        await request(app)
          .post('/api/sessions')
          .send({ ...base, targetUrl: 'nope' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/sessions')
          .send({ ...base, projectId: 'missing' })
      ).status,
    ).toBe(404);
    expect((await request(app).post('/api/sessions').send(base)).status).toBe(409);
  });

  it('returns JSON 404 for unknown API routes and sessions', async () => {
    expect((await request(app).get('/api/nope')).status).toBe(404);
    expect((await request(app).get('/api/sessions/missing')).status).toBe(404);
  });
});

describe('buildRunConfig', () => {
  it('always allows the target origin and applies budget defaults', () => {
    const config = buildRunConfig({
      projectId: 'p',
      targetUrl: 'http://localhost:3000/login?x=1',
      persona: 'Happy Path User',
      allowedOrigins: ['https://auth.example.com/callback', 'localhost:3000', '%%bad'],
      budgets: { maxSteps: 10 },
    });
    expect(config).toEqual({
      budgets: { maxSteps: 10, maxDurationMs: 300_000, maxTokens: 200_000 },
      allowedOrigins: ['http://localhost:3000', 'https://auth.example.com'],
      allowDestructive: false,
      settleMs: 300,
    });
  });
});

describe('planner endpoint (demo mode)', () => {
  it('answers with a ref from the snapshot and meters the call per session', async () => {
    const project = await prisma.project.create({ data: { name: 'AI' } });
    const session = await prisma.testSession.create({
      data: {
        projectId: project.id,
        name: 'r',
        targetUrl: 'http://x',
        persona: 'Happy Path User',
        status: 'RUNNING',
      },
    });

    const res = await request(app).post('/api/ai/next-action').send(nextActionBody(session.id));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: { type: 'fill', ref: 'e9', text: 'testuser@ghostiq.io' },
      model: 'mock/demo',
      demo: true,
      usage: { costUsd: 0 },
    });

    await waitFor(
      async () => (await prisma.llmCall.count({ where: { sessionId: session.id } })) >= 1,
    );
    const detail = await request(app).get(`/api/sessions/${session.id}`);
    expect(detail.body.llmUsage).toMatchObject({ calls: 1, failedCalls: 0 });
  });

  it('walks the login form using history, then finishes', async () => {
    const step = (kind: string, summary: string) => ({
      stepNumber: 2,
      kind,
      summary,
      status: 'PASSED',
    });
    const afterEmail = await request(app)
      .post('/api/ai/next-action')
      .send(nextActionBody('s', [step('FILL', 'Fill textbox "Email address"')]));
    expect(afterEmail.body.action).toMatchObject({ type: 'fill', ref: 'e11' });

    const done = await request(app)
      .post('/api/ai/next-action')
      .send(
        nextActionBody('s', [
          step('FILL', 'Fill textbox "Email address"'),
          step('FILL', 'Fill textbox "Password"'),
          step('CLICK', 'Click button "Sign In"'),
        ]),
      );
    expect(done.body.action).toMatchObject({ type: 'finish', goalMet: true });
  });

  it('rejects malformed planner requests', async () => {
    const res = await request(app).post('/api/ai/next-action').send({ sessionId: 's' });
    expect(res.status).toBe(400);
    expect(res.body.error.kind).toBe('bad_request');
  });

  it('exposes LLM status with usage totals', async () => {
    const res = await request(app).get('/api/llm/status');
    expect(res.body).toMatchObject({ mode: 'demo', provider: 'mock' });
    expect(res.body.usage.allTime.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('runner protocol', () => {
  it('dispatches a run, stores steps with evidence, finishes, and accepts a trace', async () => {
    const project = await prisma.project.create({ data: { name: 'Protocol' } });
    const agent = await connectAgent(project.id);
    const received = new Promise<RunTestCommand>((resolve) =>
      agent.once(SocketEvents.runStart, resolve),
    );

    const started = await request(app)
      .post('/api/sessions')
      .send({
        projectId: project.id,
        targetUrl: 'http://localhost:3000',
        persona: 'Happy Path User',
        goal: 'Log in',
        budgets: { maxSteps: 5 },
      });
    expect(started.status).toBe(201);
    const command = await received;
    expect(command).toMatchObject({
      sessionId: started.body.id,
      goal: 'Log in',
      config: {
        budgets: { maxSteps: 5 },
        allowedOrigins: ['http://localhost:3000'],
        allowDestructive: false,
      },
    });

    agent.emit(SocketEvents.stepCompleted, {
      sessionId: command.sessionId,
      stepNumber: 2,
      action: 'CLICK',
      description: 'Click button "Sign In" (submit)',
      status: 'PASSED',
      selector: 'page.getByRole("button", { name: "Sign In" })',
      agentAction: { type: 'click', ref: 'e12', reason: 'submit' },
      locator: {
        ref: 'e12',
        role: 'button',
        name: 'Sign In',
        code: 'page.getByRole("button", { name: "Sign In" })',
      },
      url: 'http://localhost:3000/',
      durationMs: 120,
      issues: [{ kind: 'http_error', message: 'POST /api/broken -> 500', status: 500 }],
      networkRequests: [
        { url: 'http://localhost:3000/api/broken', method: 'POST', status: 500, latencyMs: 12 },
      ],
    });
    agent.emit(SocketEvents.sessionCompleted, {
      sessionId: command.sessionId,
      status: 'PASSED',
      endReason: 'goal_met',
      summary: 'Logged in',
      stats: { steps: 2, tokens: 300, durationMs: 900, issues: 1 },
    });

    const session = await waitFor(async () => {
      const s = await prisma.testSession.findUnique({
        where: { id: command.sessionId },
        include: { steps: true },
      });
      return s?.status === 'PASSED' && s.steps.length === 1 ? s : null;
    });
    expect(session).toMatchObject({ endReason: 'goal_met', summary: 'Logged in', goal: 'Log in' });
    const step = session.steps[0]!;
    expect(JSON.parse(step.issuesJson!)).toEqual([expect.objectContaining({ kind: 'http_error' })]);
    expect(JSON.parse(step.locatorJson!)).toMatchObject({ role: 'button', name: 'Sign In' });
    expect(JSON.parse(step.actionJson!)).toMatchObject({ type: 'click', ref: 'e12' });

    const endpoint = await prisma.endpointHealth.findFirst({ where: { projectId: project.id } });
    expect(endpoint).toMatchObject({ url: 'http://localhost:3000/api/broken', errorCount: 1 });

    const trace = await request(app)
      .put(`/api/sessions/${command.sessionId}/trace`)
      .set('content-type', 'application/zip')
      .send(Buffer.from('PK fake zip'));
    expect(trace.status).toBe(201);
    expect((await request(app).get(trace.body.traceUrl)).status).toBe(200);

    agent.disconnect();
  });

  it('ignores events for runs the socket does not own', async () => {
    const owner = await prisma.project.create({ data: { name: 'Owner' } });
    const session = await prisma.testSession.create({
      data: {
        projectId: owner.id,
        name: 'r',
        targetUrl: 'http://x',
        persona: 'p',
        status: 'RUNNING',
      },
    });
    const intruder = await connectAgent(
      (await prisma.project.create({ data: { name: 'Intruder' } })).id,
    );

    intruder.emit(SocketEvents.sessionCompleted, {
      sessionId: session.id,
      status: 'PASSED',
      endReason: 'goal_met',
      summary: 'spoofed',
      stats: { steps: 0, tokens: 0, durationMs: 0, issues: 0 },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect((await prisma.testSession.findUnique({ where: { id: session.id } }))!.status).toBe(
      'RUNNING',
    );
    intruder.disconnect();
  });

  it('cancels a run and fails orphaned runs when the runner disconnects', async () => {
    const project = await prisma.project.create({ data: { name: 'Cancel' } });
    const agent = await connectAgent(project.id);
    const started = await request(app).post('/api/sessions').send({
      projectId: project.id,
      targetUrl: 'http://localhost:3000',
      persona: 'Happy Path User',
    });

    const cancelled = new Promise<{ sessionId: string }>((resolve) =>
      agent.once(SocketEvents.runCancel, resolve),
    );
    expect((await request(app).post(`/api/sessions/${started.body.id}/cancel`)).status).toBe(202);
    expect((await cancelled).sessionId).toBe(started.body.id);

    agent.disconnect();
    const session = await waitFor(async () => {
      const s = await prisma.testSession.findUnique({ where: { id: started.body.id } });
      return s?.status === 'FAILED' ? s : null;
    });
    expect(session.endReason).toBe('runner_disconnected');
    expect((await request(app).post(`/api/sessions/${started.body.id}/cancel`)).status).toBe(409);
  });
});
