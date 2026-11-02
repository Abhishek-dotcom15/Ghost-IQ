import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createPrismaClient, type PrismaClient } from '../db.js';
import { loadEnv } from '../env.js';
import { createLlmRuntime } from '../llm.js';
import { AiService } from '../services/ai.js';
import { PersonaRegistry } from '../services/personas.js';
import { allowedGithubUser } from './routes.js';
import { parseCookies } from './tokens.js';

// A server with authentication ON, GitHub sign-in against a fake GitHub, hosted mode.
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-auth-'));
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  GHOSTIQ_SCREENSHOT_DIR: path.join(tmp, 'screenshots'),
  GHOSTIQ_ARTIFACT_DIR: path.join(tmp, 'artifacts'),
  GHOSTIQ_LLM_PROVIDER: 'mock',
  GHOSTIQ_AUTH: 'on',
  GHOSTIQ_ADMIN_TOKEN: ADMIN_TOKEN,
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  GHOSTIQ_GITHUB_ALLOWED_USERS: 'alice-gq,bob-gq',
  GHOSTIQ_GITHUB_OAUTH_URL: 'https://github.test',
  GHOSTIQ_GITHUB_API_URL: 'https://api.github.test',
  GHOSTIQ_HOSTED: 'true',
});

// Fake GitHub: the code names the user.
const GITHUB_USERS: Record<string, { id: number; login: string }> = {
  'code-alice': { id: 9_100_001, login: 'alice-gq' },
  'code-bob': { id: 9_100_002, login: 'bob-gq' },
  'code-mallory': { id: 9_100_003, login: 'mallory-gq' },
};
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://github.test/login/oauth/access_token') {
    const { code } = JSON.parse(String(init?.body));
    return Response.json(
      GITHUB_USERS[code] ? { access_token: `tok-${code}` } : { error: 'bad_verification_code' },
    );
  }
  if (url === 'https://api.github.test/user') {
    const code = String((init?.headers as Record<string, string>).authorization).replace(
      'Bearer tok-',
      '',
    );
    const u = GITHUB_USERS[code]!;
    return Response.json({ id: u.id, login: u.login, name: u.login, avatar_url: null });
  }
  return new Response('not found', { status: 404 });
};

let prisma: PrismaClient;
let built: ReturnType<typeof createApp>;
let app: ReturnType<typeof createApp>['app'];
let baseUrl: string;
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

beforeAll(async () => {
  prisma = createPrismaClient(env.DATABASE_URL);
  // Fresh GitHub users for this suite: the first one to sign in becomes admin.
  await prisma.user.deleteMany({ where: { githubId: { not: null } } });
  const llm = createLlmRuntime(env, prisma);
  built = createApp({
    env,
    prisma,
    ai: new AiService(llm.client),
    llm,
    personas: new PersonaRegistry(prisma),
    fetch: fakeFetch,
  });
  app = built.app;
  await new Promise<void>((resolve) => built.server.listen(0, resolve));
  baseUrl = `http://localhost:${(built.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await built.io.close();
  await prisma.$disconnect();
});

/** Full GitHub sign-in round trip; returns the session cookie. */
async function githubLogin(code: string): Promise<{ status: number; cookie?: string }> {
  const start = await request(app).get('/auth/github?returnTo=/findings');
  const location = new URL(start.headers.location!);
  const state = location.searchParams.get('state')!;
  const stateCookie = (start.headers['set-cookie'] as unknown as string[])
    .find((c) => c.startsWith('ghostiq_oauth_state='))!
    .split(';')[0]!;
  const cb = await request(app)
    .get(`/auth/github/callback?code=${code}&state=${state}`)
    .set('cookie', stateCookie);
  const session = ((cb.headers['set-cookie'] as unknown as string[]) ?? []).find(
    (c) => c.startsWith('ghostiq_session=') && !c.includes('Max-Age=0'),
  );
  return { status: cb.status, cookie: session?.split(';')[0] };
}

describe('configuration safety', () => {
  it('refuses to start with auth on and no way to sign in, or open GitHub sign-in', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/no way to sign in/);
    expect(() =>
      loadEnv({ GHOSTIQ_AUTH: 'on', GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y' }),
    ).toThrow(/GHOSTIQ_GITHUB_ALLOWED_USERS/);
    expect(() => loadEnv({ GHOSTIQ_AUTH: 'on', GHOSTIQ_ADMIN_TOKEN: 'short' })).toThrow(
      /24 characters/,
    );
    expect(allowedGithubUser('Alice', 'alice,bob')).toBe(true);
    expect(allowedGithubUser('eve', 'alice')).toBe(false);
    expect(allowedGithubUser('eve', '*')).toBe(true);
  });
});

describe('anonymous visitors', () => {
  it('see health and sign-in options, nothing private', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    const me = await request(app).get('/api/me');
    expect(me.body).toMatchObject({
      authEnabled: true,
      principal: 'anonymous',
      signIn: { github: true, adminToken: true },
    });
    const priv = await request(app).post('/api/projects').set(admin).send({ name: 'Private' });
    expect(
      (await request(app).get('/api/projects')).body.map((p: { id: string }) => p.id),
    ).not.toContain(priv.body.id);
    expect((await request(app).get(`/api/projects/${priv.body.id}`)).status).toBe(401);
    expect((await request(app).post('/api/projects').send({ name: 'x' })).status).toBe(401);
    expect((await request(app).get('/api/llm/status')).status).toBe(401);
    expect((await request(app).get(`/screenshots/${priv.body.id}_1.png`)).status).toBe(401);
  });

  it('can read a public project but not change it', async () => {
    const p = await request(app).post('/api/projects').set(admin).send({ name: 'Demo' });
    expect(
      (await request(app).patch(`/api/projects/${p.body.id}`).set(admin).send({ public: true }))
        .status,
    ).toBe(200);
    expect((await request(app).get(`/api/projects/${p.body.id}`)).status).toBe(200);
    expect(
      (await request(app).get('/api/projects')).body.map((x: { id: string }) => x.id),
    ).toContain(p.body.id);
    const run = await request(app)
      .post('/api/sessions')
      .send({ projectId: p.body.id, targetUrl: 'https://example.com', personaId: 'happy-path' });
    expect(run.status).toBe(403);
  });
});

describe('admin token', () => {
  it('works as a bearer token and as a dashboard login', async () => {
    expect((await request(app).post('/auth/token').send({ token: 'wrong' })).status).toBe(401);
    const login = await request(app).post('/auth/token').send({ token: ADMIN_TOKEN });
    expect(login.status).toBe(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await request(app).get('/api/me').set('cookie', cookie.split(';')[0]!);
    expect(me.body).toMatchObject({ principal: 'user', admin: true, user: { login: 'admin' } });
    // Session tokens are stored hashed.
    const raw = parseCookies(cookie.split(';')[0]).ghostiq_session!;
    expect(await prisma.authSession.count({ where: { tokenHash: raw } })).toBe(0);
    await request(app).post('/auth/logout').set('cookie', cookie.split(';')[0]!);
    expect(
      (await request(app).get('/api/me').set('cookie', cookie.split(';')[0]!)).body.principal,
    ).toBe('anonymous');
  });

  it('refuses cross-origin cookie writes (CSRF)', async () => {
    const login = await request(app).post('/auth/token').send({ token: ADMIN_TOKEN });
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const evil = await request(app)
      .post('/api/projects')
      .set('cookie', cookie)
      .set('origin', 'https://evil.example')
      .send({ name: 'x' });
    expect(evil.status).toBe(403);
    const ok = await request(app)
      .post('/api/projects')
      .set('cookie', cookie)
      .send({ name: 'Mine' });
    expect(ok.status).toBe(201);
  });
});

describe('project API keys', () => {
  it('are shown once, stored hashed, scoped to one project, and revocable', async () => {
    const a = (await request(app).post('/api/projects').set(admin).send({ name: 'Key A' })).body;
    const b = (await request(app).post('/api/projects').set(admin).send({ name: 'Key B' })).body;
    const created = await request(app)
      .post(`/api/projects/${a.id}/keys`)
      .set(admin)
      .send({ name: 'CI' });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^gq_/);
    const listed = await request(app).get(`/api/projects/${a.id}/keys`).set(admin);
    expect(JSON.stringify(listed.body)).not.toContain(key);
    expect(await prisma.apiKey.count({ where: { hash: key } })).toBe(0);

    const asKey = { authorization: `Bearer ${key}` };
    expect((await request(app).get(`/api/projects/${a.id}`).set(asKey)).status).toBe(200);
    expect((await request(app).get(`/api/projects/${b.id}`).set(asKey)).status).toBe(404);
    expect(
      (await request(app).get('/api/projects').set(asKey)).body.map((p: { id: string }) => p.id),
    ).toEqual([a.id]);
    expect((await request(app).post('/api/projects').set(asKey).send({ name: 'x' })).status).toBe(
      403,
    );
    expect((await request(app).get(`/api/projects/${a.id}/keys`).set(asKey)).status).toBe(403);
    // Authorized to start runs (409 = no runner online, i.e. past the access check).
    const run = await request(app)
      .post('/api/sessions')
      .set(asKey)
      .send({ projectId: a.id, targetUrl: 'https://example.com', personaId: 'happy-path' });
    expect(run.status).toBe(409);
    // The planner only serves runs in progress.
    const plan = await request(app)
      .post('/api/ai/next-action')
      .set(asKey)
      .send({ sessionId: 'not-running' });
    expect(plan.status).toBe(404);

    await request(app).delete(`/api/keys/${created.body.id}`).set(admin);
    expect((await request(app).get(`/api/projects/${a.id}`).set(asKey)).status).toBe(401);

    const audit = await request(app).get(`/api/projects/${a.id}/audit`).set(admin);
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['project.create', 'api_key.create', 'api_key.revoke']),
    );
  });
});

describe('GitHub sign-in and project roles', () => {
  it('signs in allowed users, makes the first one admin, and refuses others', async () => {
    const alice = await githubLogin('code-alice');
    expect(alice.status).toBe(302);
    expect(alice.cookie).toBeTruthy();
    const me = await request(app).get('/api/me').set('cookie', alice.cookie!);
    expect(me.body).toMatchObject({ user: { login: 'alice-gq' }, admin: true });

    const bob = await githubLogin('code-bob');
    const bobMe = await request(app).get('/api/me').set('cookie', bob.cookie!);
    expect(bobMe.body).toMatchObject({ user: { login: 'bob-gq' }, admin: false });

    expect((await githubLogin('code-mallory')).status).toBe(403);
    // A callback without the state cookie is refused.
    expect(
      (await request(app).get('/auth/github/callback?code=code-alice&state=forged')).status,
    ).toBe(400);
  });

  it('enforces owner / viewer roles', async () => {
    const alice = (await githubLogin('code-alice')).cookie!;
    const bob = (await githubLogin('code-bob')).cookie!;
    const project = (
      await request(app).post('/api/projects').set('cookie', bob).send({ name: "Bob's" })
    ).body;
    expect(
      (await request(app).get(`/api/projects/${project.id}/members`).set('cookie', bob)).body[0],
    ).toMatchObject({ login: 'bob-gq', role: 'owner' });

    // Alice is admin; make a project of hers and invite Bob as viewer.
    const hers = (
      await request(app).post('/api/projects').set('cookie', alice).send({ name: "Alice's" })
    ).body;
    expect((await request(app).get(`/api/projects/${hers.id}`).set('cookie', bob)).status).toBe(
      404,
    );
    await request(app)
      .put(`/api/projects/${hers.id}/members`)
      .set('cookie', alice)
      .send({ login: 'bob-gq', role: 'viewer' });
    expect((await request(app).get(`/api/projects/${hers.id}`).set('cookie', bob)).status).toBe(
      200,
    );
    const write = await request(app)
      .post('/api/sessions')
      .set('cookie', bob)
      .send({ projectId: hers.id, targetUrl: 'https://example.com', personaId: 'happy-path' });
    expect(write.status).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/projects/${hers.id}/keys`)
          .set('cookie', bob)
          .send({ name: 'x' })
      ).status,
    ).toBe(403);
    // The last owner cannot be removed.
    expect(
      (await request(app).delete(`/api/projects/${project.id}/members/bob-gq`).set('cookie', bob))
        .status,
    ).toBe(409);
  });
});

describe('sockets', () => {
  const sockets: Socket[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  const connected = (s: Socket) => new Promise<void>((resolve) => s.on('connect', () => resolve()));

  function open(query: Record<string, string>, token?: string, cookie?: string) {
    const s = connect(baseUrl, {
      query,
      auth: token ? { token } : {},
      transports: ['websocket'],
      extraHeaders: cookie ? { cookie } : {},
    });
    sockets.push(s);
    return s;
  }

  it('rejects runners without a key for the project, and scopes events to project rooms', async () => {
    const p = (await request(app).post('/api/projects').set(admin).send({ name: 'Socket' })).body;
    const other = (await request(app).post('/api/projects').set(admin).send({ name: 'Other' }))
      .body;
    const key = (
      await request(app).post(`/api/projects/${p.id}/keys`).set(admin).send({ name: 'runner' })
    ).body.key;

    const intruder = open({ role: 'agent', projectId: p.id });
    const refused = await new Promise<string>((resolve) =>
      intruder.on('connect_error', (e) => resolve(e.message)),
    );
    expect(refused).toMatch(/Unauthorized/);

    const watcher = open({ role: 'dashboard' }, ADMIN_TOKEN);
    const outsider = open({ role: 'dashboard' }, ADMIN_TOKEN);
    await Promise.all([watcher, outsider].map(connected));
    watcher.emit('subscribe', p.id);
    outsider.emit('subscribe', other.id);
    await new Promise((r) => setTimeout(r, 100));
    const seen: string[] = [];
    watcher.on('agent-status-change', (e: { projectId: string }) =>
      seen.push(`watcher:${e.projectId}`),
    );
    outsider.on('agent-status-change', (e: { projectId: string }) =>
      seen.push(`outsider:${e.projectId}`),
    );

    const runner = open({ role: 'agent', projectId: p.id }, key);
    await connected(runner);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([`watcher:${p.id}`]);

    // Anonymous dashboards cannot join private project rooms.
    const anon = open({ role: 'dashboard' });
    await connected(anon);
    anon.emit('subscribe', p.id);
    const anonSeen: string[] = [];
    anon.on('agent-status-change', () => anonSeen.push('x'));
    await new Promise((r) => setTimeout(r, 100));
    runner.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    expect(anonSeen).toEqual([]);
  });
});

describe('hosted-mode SSRF guard and headers', () => {
  it('refuses internal run targets', async () => {
    const p = (await request(app).post('/api/projects').set(admin).send({ name: 'SSRF' })).body;
    for (const target of [
      'http://127.0.0.1:3000',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
    ]) {
      const res = await request(app)
        .post('/api/sessions')
        .set(admin)
        .send({ projectId: p.id, targetUrl: target, personaId: 'happy-path' });
      expect(res.status, target).toBe(400);
      expect(res.body.error).toMatch(/private or internal/);
    }
  });

  it('sends the security headers GhostIQ itself checks for', async () => {
    const res = await request(app).get('/healthz');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rate-limits sign-in attempts', async () => {
    let last = 0;
    for (let i = 0; i < 25; i++)
      last = (await request(app).post('/auth/token').send({ token: 'guess' })).status;
    expect(last).toBe(429);
  });
});
