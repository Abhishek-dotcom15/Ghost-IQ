import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { createPrismaClient, type PrismaClient } from './db.js';
import { loadEnv } from './env.js';
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
  app = createApp({ env, prisma, ai: new AiService(env) }).app;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GhostIQ API', () => {
  it('reports health and labels demo mode', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, llm: 'demo mode (scripted, no LLM)' });
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
