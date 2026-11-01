import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createPrismaClient, type PrismaClient } from './db.js';
import { loadEnv } from './env.js';
import { createLlmRuntime } from './llm.js';
import { AiService } from './services/ai.js';

// Integration test against a real throwaway SQLite database.
// The schema is pushed once by the vitest global setup (see vitest.config.ts).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-test-'));
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  GHOSTIQ_SCREENSHOT_DIR: path.join(tmp, 'screenshots'),
  GHOSTIQ_LLM_PROVIDER: 'mock',
});

let prisma: PrismaClient;
let app: ReturnType<typeof createApp>['app'];

beforeAll(() => {
  prisma = createPrismaClient(env.DATABASE_URL);
  const llm = createLlmRuntime(env, prisma);
  app = createApp({ env, prisma, ai: new AiService(llm.client), llm }).app;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** LLM calls are recorded asynchronously; wait until the expected count lands. */
async function waitForLlmCalls(sessionId: string, count: number) {
  for (let i = 0; i < 50; i++) {
    if ((await prisma.llmCall.count({ where: { sessionId } })) >= count) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('LLM call was not recorded');
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
    expect(list.status).toBe(200);
    expect(list.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Shop', agentOnline: false })]),
    );
  });

  it('rejects a project without a name', async () => {
    const res = await request(app).post('/api/projects').send({});
    expect(res.status).toBe(400);
  });

  it('refuses to start a run when no runner is connected', async () => {
    const project = await request(app).post('/api/projects').send({ name: 'Offline' });
    const res = await request(app).post('/api/sessions').send({
      projectId: project.body.id,
      targetUrl: 'http://localhost:3000',
      persona: 'Happy Path User',
    });
    expect(res.status).toBe(409);
  });

  it('returns JSON 404 for unknown API routes and sessions', async () => {
    expect((await request(app).get('/api/nope')).status).toBe(404);
    expect((await request(app).get('/api/sessions/missing')).status).toBe(404);
  });
});

describe('AI endpoints (demo mode)', () => {
  it('plans the first real step after navigation and records the LLM call per session', async () => {
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

    const res = await request(app)
      .post('/api/ai/plan-step')
      .send({
        sessionId: session.id,
        htmlSnapshot: '<input type="email" name="email" />',
        currentUrl: 'http://x',
        history: [{ stepNumber: 1, action: 'GOTO', description: 'open', status: 'PASSED' }],
        goal: 'Log in',
        persona: 'Happy Path User',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: 'TYPE',
      selector: 'input#email, input[type="email"]',
      value: 'testuser@ghostiq.io',
    });

    await waitForLlmCalls(session.id, 1);
    const detail = await request(app).get(`/api/sessions/${session.id}`);
    expect(detail.body.llmUsage).toMatchObject({ calls: 1, failedCalls: 0, costUsd: 0 });
    expect(detail.body.llmUsage.tokensIn).toBeGreaterThan(0);
  });

  it('heals the mock app submit button and declines unknown selectors', async () => {
    const healed = await request(app).post('/api/ai/heal-selector').send({
      failedSelector: '#submit-btn',
      htmlSnapshot: '<button type="submit">Sign in</button>',
      goal: 'g',
      persona: 'p',
    });
    expect(healed.body).toMatchObject({ healedSelector: 'button[type="submit"]', confidence: 0.9 });

    const declined = await request(app)
      .post('/api/ai/heal-selector')
      .send({ failedSelector: '#other', htmlSnapshot: '', goal: 'g', persona: 'p' });
    expect(declined.body.confidence).toBe(0);
  });

  it('exposes LLM status with usage totals', async () => {
    const res = await request(app).get('/api/llm/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'demo', provider: 'mock' });
    expect(res.body.usage.allTime.calls).toBeGreaterThanOrEqual(1);
    expect(res.body.usage.last24h).toHaveProperty('costUsd');
  });
});
