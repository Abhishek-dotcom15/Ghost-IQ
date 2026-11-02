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
import { PersonaRegistry } from './services/personas.js';

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
  built = createApp({
    env,
    prisma,
    ai: new AiService(llm.client),
    llm,
    personas: new PersonaRegistry(prisma),
  });
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
    persona: {
      id: 'happy-path',
      name: 'Happy Path User',
      description: 'Methodical user',
      traits: '',
      input_strategy: 'valid',
    },
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
      personaId: 'happy-path',
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

  it('answers client mistakes with 4xx, not 500', async () => {
    const badJson = await request(app)
      .post('/api/sessions')
      .set('content-type', 'application/json')
      .send('{not json');
    expect(badJson.status).toBe(400);
    expect(badJson.body).toEqual({ error: 'Bad request' });
    expect((await request(app).get('/screenshots/missing.png')).status).toBe(404);
    expect((await request(app).get('/artifacts/missing/trace.zip')).status).toBe(404);
  });

  it('keeps API 404s as JSON when the dashboard is served (SPA fallback)', async () => {
    const dashboardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-dash-'));
    fs.writeFileSync(
      path.join(dashboardDir, 'index.html'),
      '<!doctype html><title>GhostIQ</title>',
    );
    const withDashboard = createApp({
      env: { ...env, GHOSTIQ_DASHBOARD_DIR: dashboardDir },
      prisma,
      ai: new AiService(createLlmRuntime(env, prisma).client),
      llm: createLlmRuntime(env, prisma),
      personas: new PersonaRegistry(prisma),
    });
    try {
      const api = await request(withDashboard.app).get('/api/nope');
      expect(api.status).toBe(404);
      expect(api.body).toEqual({ error: 'Not found' });
      const page = await request(withDashboard.app).get('/sessions/anything');
      expect(page.status).toBe(200);
      expect(page.text).toContain('<title>GhostIQ</title>');
    } finally {
      await withDashboard.io.close();
    }
  });
});

describe('buildRunConfig', () => {
  it('always allows the target origin and applies budget defaults', () => {
    const config = buildRunConfig({
      projectId: 'p',
      targetUrl: 'http://localhost:3000/login?x=1',
      personaId: 'happy-path',
      allowedOrigins: ['https://auth.example.com/callback', 'localhost:3000', '%%bad'],
      budgets: { maxSteps: 10 },
    });
    expect(config).toEqual({
      budgets: { maxSteps: 10, maxDurationMs: 300_000, maxTokens: 200_000 },
      allowedOrigins: ['http://localhost:3000', 'https://auth.example.com'],
      allowDestructive: false,
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
        personaId: 'happy-path',
        goal: 'Log in',
        budgets: { maxSteps: 5 },
      });
    expect(started.status).toBe(201);
    const command = await received;
    expect(command).toMatchObject({
      sessionId: started.body.id,
      goal: 'Log in',
      seed: 42,
      persona: { id: 'happy-path', name: 'Happy Path User', input_strategy: 'valid' },
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
      personaId: 'happy-path',
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

describe('findings engine', () => {
  /** Starts a run for a persona, plays steps through the socket, finishes it, returns its id. */
  async function playRun(
    agent: Socket,
    projectId: string,
    personaId: string,
    steps: Array<Record<string, unknown>>,
  ): Promise<string> {
    const received = new Promise<RunTestCommand>((resolve) =>
      agent.once(SocketEvents.runStart, resolve),
    );
    const started = await request(app).post('/api/sessions').send({
      projectId,
      targetUrl: 'http://shop.test/',
      personaId,
      consent: true,
    });
    expect(started.status).toBe(201);
    const { sessionId } = await received;
    steps.forEach((step, i) =>
      agent.emit(SocketEvents.stepCompleted, {
        sessionId,
        stepNumber: i + 1,
        action: 'CLICK',
        description: `step ${i + 1}`,
        status: 'PASSED',
        url: 'http://shop.test/cart',
        ...step,
      }),
    );
    await waitFor(
      async () => (await prisma.testStep.count({ where: { sessionId } })) === steps.length,
    );
    agent.emit(SocketEvents.sessionCompleted, {
      sessionId,
      status: 'PASSED',
      endReason: 'goal_met',
      summary: 'done',
      stats: { steps: steps.length, tokens: 0, durationMs: 1, issues: 0 },
    });
    await waitFor(
      async () =>
        (await prisma.testSession.findUnique({ where: { id: sessionId } }))?.status === 'PASSED',
    );
    return sessionId;
  }

  const coupon = {
    kind: 'page_error',
    message: "Uncaught TypeError: Cannot read properties of undefined (reading 'coupons')",
  };
  const xss = {
    kind: 'script_injection',
    message: 'Typed text ran as <script>alert(1)</script>',
    url: 'http://shop.test/products',
  };

  it('deduplicates across runs, attributes personas, and remembers triage', async () => {
    const project = await prisma.project.create({ data: { name: 'Findings' } });
    const agent = await connectAgent(project.id);

    const first = await playRun(agent, project.id, 'happy-path', [
      { action: 'GOTO', description: 'Open shop' },
      { issues: [coupon], value: 'x' },
    ]);
    await playRun(agent, project.id, 'impatient-user', [
      { action: 'GOTO', description: 'Open shop' },
      { issues: [coupon, xss] },
    ]);

    const list = await request(app).get(`/api/projects/${project.id}/findings`);
    expect(list.body.summary.total).toBe(2);
    const [critical, runtime] = list.body.findings;
    expect(critical).toMatchObject({
      type: 'script_injection',
      severity: 'critical',
      personas: ['Impatient User'],
    });
    expect(runtime).toMatchObject({
      type: 'runtime_error',
      route: '/cart',
      recurrences: 2,
      personas: ['Happy Path User', 'Impatient User'],
    });
    expect(runtime.repro).toEqual(['1. Open shop', '2. step 2 with "x"']);
    expect(runtime.evidence.sessionId).not.toBe(first);
    expect(list.body.summary.byPersona).toEqual([
      { persona: 'Impatient User', total: 2, unique: 1 },
      { persona: 'Happy Path User', total: 1, unique: 0 },
    ]);

    // Dismissed stays dismissed when seen again; fixed reopens as a regression.
    await request(app)
      .patch(`/api/findings/${critical.id}`)
      .send({ status: 'dismissed', note: 'test data' });
    await request(app).patch(`/api/findings/${runtime.id}`).send({ status: 'fixed' });
    expect(
      (await request(app).patch(`/api/findings/${runtime.id}`).send({ status: 'nope' })).status,
    ).toBe(400);
    const third = await playRun(agent, project.id, 'chaotic-explorer', [{ issues: [coupon, xss] }]);

    const after = (await request(app).get(`/api/projects/${project.id}/findings`)).body.findings;
    expect(after.find((f: { id: string }) => f.id === critical.id)).toMatchObject({
      status: 'dismissed',
      recurrences: 2,
    });
    expect(after.find((f: { id: string }) => f.id === runtime.id)).toMatchObject({
      status: 'open',
      recurrences: 3,
    });
    expect(after.find((f: { id: string }) => f.id === runtime.id).triageNote).toContain(
      'Regressed',
    );

    const scoped = await request(app).get(`/api/sessions/${third}/findings`);
    expect(scoped.body.summary.total).toBe(2);
    agent.disconnect();
  });

  it('runs run-level oracles when a run finishes', async () => {
    const project = await prisma.project.create({ data: { name: 'Run level' } });
    const agent = await connectAgent(project.id);
    const sessionId = await playRun(agent, project.id, 'form-stress-tester', [
      {
        action: 'FILL',
        value: '',
        input: { strategy: 'empty', kind: 'email', field: 'Email' },
        networkRequests: [
          { url: 'http://shop.test/api/products?q=a', method: 'GET', status: 200, latencyMs: 1650 },
        ],
      },
      {
        networkRequests: [
          { url: 'http://shop.test/api/signup', method: 'POST', status: 201, latencyMs: 20 },
        ],
      },
    ]);
    const { findings } = (await request(app).get(`/api/sessions/${sessionId}/findings`)).body;
    expect(
      findings.map((f: { type: string; route: string }) => `${f.type} ${f.route}`).sort(),
    ).toEqual(['slow_endpoint /api/products', 'validation /api/signup']);
    expect(findings.find((f: { type: string }) => f.type === 'validation').confidence).toBe(
      'suspected',
    );
    agent.disconnect();
  });

  it('renders JSON, HTML, JUnit and SARIF reports with escaping', async () => {
    const project = await prisma.project.create({ data: { name: 'Reports' } });
    const agent = await connectAgent(project.id);
    const sessionId = await playRun(agent, project.id, 'happy-path', [{ issues: [xss, coupon] }]);

    const json = await request(app).get(`/api/sessions/${sessionId}/report?format=json`);
    expect(json.body.summary).toMatchObject({ critical: 1, high: 1 });
    expect(json.body.run.persona).toBe('Happy Path User');

    const html = await request(app).get(`/api/sessions/${sessionId}/report?format=html`);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.text).not.toContain('<script>alert(1)</script>');
    expect(html.text).toContain('&lt;script&gt;');

    const junit = await request(app).get(`/api/sessions/${sessionId}/report?format=junit`);
    expect(junit.text).toContain('<testsuites name="GhostIQ" tests="3" failures="2">');

    const sarif = await request(app).get(`/api/sessions/${sessionId}/report?format=sarif`);
    const doc = JSON.parse(sarif.text);
    expect(doc.version).toBe('2.1.0');
    expect(doc.runs[0].results.map((r: { level: string }) => r.level)).toEqual(['error', 'error']);
    expect(doc.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toContain(
      'ghostiq/script_injection',
    );

    expect((await request(app).get(`/api/sessions/${sessionId}/report?format=pdf`)).status).toBe(
      400,
    );
    const projectReport = await request(app).get(`/api/projects/${project.id}/report?format=json`);
    expect(projectReport.body.findings).toHaveLength(2);
    agent.disconnect();
  });
});

describe('personas API', () => {
  const CUSTOM = `id: checkout-rusher
name: Checkout Rusher
description: Hurries through checkout.
input_strategy: boundary
behaviors:
  - { type: double_click, probability: 0.5 }
seed: 99
`;

  it('lists the eight built-in personas', async () => {
    const res = await request(app).get('/api/personas');
    expect(res.status).toBe(200);
    const builtins = res.body.filter((p: { source: string }) => p.source === 'builtin');
    expect(builtins).toHaveLength(8);
    expect(builtins[0]).toMatchObject({
      editable: false,
      spec: expect.any(Object),
      yaml: expect.any(String),
    });
  });

  it('validates YAML with line numbers and previews generated inputs', async () => {
    const bad = await request(app)
      .post('/api/personas/validate')
      .send({ yaml: `${CUSTOM}network: 5g\n` });
    expect(bad.body).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ line: 8, path: 'network' })],
    });

    const good = await request(app).post('/api/personas/validate').send({ yaml: CUSTOM });
    expect(good.body).toMatchObject({
      ok: true,
      persona: { id: 'checkout-rusher', seed: 99 },
      preview: { behaviors: ['double_click (50%)'], device: 'Laptop 1280x720' },
    });
    expect(good.body.preview.sampleInputs.length).toBeGreaterThan(3);
  });

  it('creates, updates and deletes a custom persona without code changes', async () => {
    const created = await request(app).post('/api/personas').send({ yaml: CUSTOM });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'checkout-rusher',
      source: 'custom',
      editable: true,
      version: 1,
    });

    expect((await request(app).post('/api/personas').send({ yaml: CUSTOM })).status).toBe(409);

    const updated = await request(app)
      .put('/api/personas/checkout-rusher')
      .send({ yaml: CUSTOM.replace('seed: 99', 'seed: 100') });
    expect(updated.body).toMatchObject({ version: 2, spec: { seed: 100 } });

    const invalid = await request(app)
      .put('/api/personas/checkout-rusher')
      .send({ yaml: CUSTOM.replace('boundary', 'chaos') });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors[0]).toMatchObject({ line: 4, path: 'input_strategy' });

    expect((await request(app).delete('/api/personas/checkout-rusher')).status).toBe(204);
    expect((await request(app).get('/api/personas/checkout-rusher')).status).toBe(404);
  });

  it('protects built-in personas from edits and id clashes', async () => {
    const clash = await request(app)
      .post('/api/personas')
      .send({ yaml: 'id: happy-path\nname: Fake\ndescription: x\n' });
    expect(clash.status).toBe(409);
    expect((await request(app).delete('/api/personas/happy-path')).status).toBe(409);
  });

  it('requires consent for opt-in personas and rejects unknown personas', async () => {
    const project = await prisma.project.create({ data: { name: 'Consent' } });
    const agent = await connectAgent(project.id);
    const base = { projectId: project.id, targetUrl: 'http://localhost:3000' };

    const missing = await request(app)
      .post('/api/sessions')
      .send({ ...base, personaId: 'nobody' });
    expect(missing.status).toBe(404);

    const noConsent = await request(app)
      .post('/api/sessions')
      .send({ ...base, personaId: 'security-hygiene' });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.requiresConsent).toBe(true);

    const received = new Promise<RunTestCommand>((resolve) =>
      agent.once(SocketEvents.runStart, resolve),
    );
    const ok = await request(app)
      .post('/api/sessions')
      .send({ ...base, personaId: 'security-hygiene', consent: true, seed: 7 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      personaId: 'security-hygiene',
      seed: 7,
      persona: 'Security Hygiene Prober',
    });
    const command = await received;
    expect(command.seed).toBe(7);
    // Falls back to the persona's own goal when the run does not give one.
    expect(command.goal).toBe('Check that errors, admin pages and user input are handled safely.');
    agent.disconnect();
  });
});
