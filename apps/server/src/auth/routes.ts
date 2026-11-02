import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../db.js';
import { githubConfigured, type Env } from '../env.js';
import { ROLES } from './access.js';
import type { AuditLog } from './audit.js';
import { SESSION_COOKIE, isAdmin, type Authenticator } from './principal.js';
import {
  cookie,
  newApiKey,
  newSessionToken,
  newState,
  parseCookies,
  safeEqual,
  sha256,
} from './tokens.js';

const STATE_COOKIE = 'ghostiq_oauth_state';

export interface AuthDeps {
  prisma: PrismaClient;
  env: Env;
  auth: Authenticator;
  audit: AuditLog;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

function isHttps(req: Request, env: Env): boolean {
  return req.secure || (env.GHOSTIQ_PUBLIC_URL ?? '').startsWith('https://');
}

function baseUrl(req: Request, env: Env): string {
  return (env.GHOSTIQ_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

/** Only same-site paths, so the login redirect cannot be turned into an open redirect. */
function safeReturnTo(value: unknown): string {
  return typeof value === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) ? value : '/';
}

export function allowedGithubUser(login: string, setting: string | undefined): boolean {
  const list = (setting ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes('*') || list.includes(login.toLowerCase());
}

export function registerAuthRoutes(app: Express, deps: AuthDeps) {
  const { prisma, env, auth, audit } = deps;
  const doFetch = deps.fetch ?? fetch;
  const ttlSeconds = env.GHOSTIQ_SESSION_TTL_HOURS * 3600;

  async function startSession(req: Request, res: Response, userId: string) {
    const token = newSessionToken();
    await prisma.authSession.create({
      data: {
        tokenHash: sha256(token),
        userId,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        ip: req.ip ?? null,
        userAgent: (req.get('user-agent') ?? '').slice(0, 300),
      },
    });
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    res.append(
      'Set-Cookie',
      cookie(SESSION_COOKIE, token, { maxAgeSeconds: ttlSeconds, secure: isHttps(req, env) }),
    );
  }

  /** Who am I, and how can I sign in? */
  app.get('/api/me', async (req, res) => {
    const p = req.principal ?? { kind: 'anonymous' as const };
    let user = null;
    if (p.kind === 'user') {
      user = await prisma.user.findUnique({
        where: { id: p.user.id },
        select: { id: true, login: true, name: true, avatarUrl: true, admin: true },
      });
    }
    res.json({
      authEnabled: auth.enabled,
      principal: p.kind,
      user,
      admin: isAdmin(p),
      signIn: { github: githubConfigured(env), adminToken: !!env.GHOSTIQ_ADMIN_TOKEN },
    });
  });

  // ------------------------------------------------------------- GitHub OAuth
  app.get('/auth/github', (req, res) => {
    if (!githubConfigured(env))
      return void res.status(404).json({ error: 'GitHub sign-in is not configured' });
    const state = newState();
    const returnTo = safeReturnTo(req.query.returnTo);
    res.append(
      'Set-Cookie',
      cookie(STATE_COOKIE, `${state}|${returnTo}`, {
        maxAgeSeconds: 600,
        secure: isHttps(req, env),
        path: '/auth',
      }),
    );
    const params = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID!,
      redirect_uri: `${baseUrl(req, env)}/auth/github/callback`,
      scope: 'read:user',
      state,
      allow_signup: 'false',
    });
    res.redirect(`${env.GHOSTIQ_GITHUB_OAUTH_URL}/login/oauth/authorize?${params}`);
  });

  app.get('/auth/github/callback', async (req, res) => {
    const fail = (status: number, message: string) =>
      res.status(status).type('text/plain').send(message);
    if (!githubConfigured(env)) return void fail(404, 'GitHub sign-in is not configured.');
    const [expected, returnTo] = (parseCookies(req.headers.cookie)[STATE_COOKIE] ?? '').split('|');
    res.append(
      'Set-Cookie',
      cookie(STATE_COOKIE, '', { maxAgeSeconds: 0, secure: isHttps(req, env), path: '/auth' }),
    );
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!expected || !state || !safeEqual(state, expected) || !code) {
      return void fail(
        400,
        'Sign-in failed: the login request expired or did not come from this site. Try again.',
      );
    }

    let profile: { id: number; login: string; name: string | null; avatar_url: string | null };
    try {
      const tokenRes = await doFetch(`${env.GHOSTIQ_GITHUB_OAUTH_URL}/login/oauth/access_token`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${baseUrl(req, env)}/auth/github/callback`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const token = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!token.access_token)
        throw new Error(token.error ?? `token exchange returned ${tokenRes.status}`);
      const userRes = await doFetch(`${env.GHOSTIQ_GITHUB_API_URL}/user`, {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'GhostIQ',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!userRes.ok) throw new Error(`GitHub /user returned ${userRes.status}`);
      profile = (await userRes.json()) as typeof profile;
    } catch (err) {
      console.error('[auth] GitHub sign-in failed:', err);
      return void fail(502, 'Sign-in failed: GitHub could not be reached. Try again.');
    }

    if (!allowedGithubUser(profile.login, env.GHOSTIQ_GITHUB_ALLOWED_USERS)) {
      await audit.record(
        { kind: 'anonymous' },
        { action: 'auth.denied', target: profile.login },
        req.ip,
      );
      return void fail(
        403,
        `GitHub user "${profile.login}" is not allowed on this GhostIQ server. Ask an admin to add you.`,
      );
    }
    // The first person to sign in administers the server.
    const isFirst = (await prisma.user.count({ where: { githubId: { not: null } } })) === 0;
    const user = await prisma.user.upsert({
      where: { githubId: profile.id },
      create: {
        githubId: profile.id,
        login: profile.login,
        name: profile.name,
        avatarUrl: profile.avatar_url,
        admin: isFirst,
      },
      update: { login: profile.login, name: profile.name, avatarUrl: profile.avatar_url },
    });
    await startSession(req, res, user.id);
    await audit.record(
      { kind: 'user', user: { id: user.id, login: user.login, admin: user.admin } },
      { action: 'auth.login', metadata: { provider: 'github', firstAdmin: isFirst && user.admin } },
      req.ip,
    );
    res.redirect(safeReturnTo(returnTo));
  });

  // -------------------------------------------------- admin token (bootstrap)
  app.post('/auth/token', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!env.GHOSTIQ_ADMIN_TOKEN || !token || !safeEqual(token, env.GHOSTIQ_ADMIN_TOKEN)) {
      await audit.record(
        { kind: 'anonymous' },
        { action: 'auth.failed', metadata: { method: 'admin_token' } },
        req.ip,
      );
      return void res.status(401).json({ error: 'Invalid admin token' });
    }
    const user = await prisma.user.upsert({
      where: { login: 'admin' },
      create: { login: 'admin', name: 'Administrator', admin: true },
      update: { admin: true },
    });
    await startSession(req, res, user.id);
    await audit.record(
      { kind: 'admin_token' },
      { action: 'auth.login', metadata: { provider: 'admin_token' } },
      req.ip,
    );
    res.json({ ok: true });
  });

  app.post('/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await prisma.authSession.deleteMany({ where: { tokenHash: sha256(token) } });
    res.append(
      'Set-Cookie',
      cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: isHttps(req, env) }),
    );
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ project admin
  const ProjectPatch = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    public: z.boolean().optional(),
  });
  app.patch('/api/projects/:id', async (req, res) => {
    const body = ProjectPatch.safeParse(req.body ?? {});
    if (!body.success)
      return void res
        .status(400)
        .json({ error: 'name (string) and public (boolean) are the editable fields' });
    const project = await prisma.project
      .update({ where: { id: req.params.id }, data: body.data })
      .catch(() => null);
    if (!project) return void res.status(404).json({ error: 'Project not found' });
    await audit.fromRequest(req, {
      action: 'project.update',
      projectId: project.id,
      metadata: body.data,
    });
    res.json(project);
  });

  app.get('/api/projects/:id/keys', async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    });
    res.json(keys);
  });

  const KeyBody = z.object({ name: z.string().trim().min(1).max(100) });
  app.post('/api/projects/:id/keys', async (req, res) => {
    const body = KeyBody.safeParse(req.body ?? {});
    if (!body.success)
      return void res
        .status(400)
        .json({ error: 'A key name is required (e.g. "CI" or "Alice laptop")' });
    const project = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!project) return void res.status(404).json({ error: 'Project not found' });
    const key = newApiKey();
    const created = await prisma.apiKey.create({
      data: {
        projectId: project.id,
        name: body.data.name,
        prefix: key.prefix,
        hash: key.hash,
        createdById: req.principal?.kind === 'user' ? req.principal.user.id : null,
      },
    });
    await audit.fromRequest(req, {
      action: 'api_key.create',
      projectId: project.id,
      target: created.id,
      metadata: { name: created.name },
    });
    // The only time the raw key is ever returned.
    res
      .status(201)
      .json({ id: created.id, name: created.name, prefix: created.prefix, key: key.raw });
  });

  app.delete('/api/keys/:id', async (req, res) => {
    const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
    if (!key) return void res.status(404).json({ error: 'Key not found' });
    await prisma.apiKey.update({
      where: { id: key.id },
      data: { revokedAt: key.revokedAt ?? new Date() },
    });
    await audit.fromRequest(req, {
      action: 'api_key.revoke',
      projectId: key.projectId,
      target: key.id,
      metadata: { name: key.name },
    });
    res.json({ ok: true });
  });

  app.get('/api/projects/:id/members', async (req, res) => {
    const members = await prisma.membership.findMany({
      where: { projectId: req.params.id },
      include: { user: { select: { id: true, login: true, name: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });
    res.json(members.map((m) => ({ ...m.user, role: m.role, since: m.createdAt })));
  });

  const MemberBody = z.object({ login: z.string().trim().min(1).max(100), role: z.enum(ROLES) });
  app.put('/api/projects/:id/members', async (req, res) => {
    const body = MemberBody.safeParse(req.body ?? {});
    if (!body.success)
      return void res
        .status(400)
        .json({ error: `login and role (${ROLES.join(', ')}) are required` });
    const user = await prisma.user.findUnique({ where: { login: body.data.login } });
    if (!user) {
      return void res
        .status(404)
        .json({ error: `No user "${body.data.login}" yet: they need to sign in once first.` });
    }
    await prisma.membership.upsert({
      where: { userId_projectId: { userId: user.id, projectId: req.params.id } },
      create: { userId: user.id, projectId: req.params.id, role: body.data.role },
      update: { role: body.data.role },
    });
    await audit.fromRequest(req, {
      action: 'member.set',
      projectId: req.params.id,
      target: user.login,
      metadata: { role: body.data.role },
    });
    res.json({ ok: true });
  });

  app.delete('/api/projects/:id/members/:login', async (req, res) => {
    const user = await prisma.user.findUnique({ where: { login: req.params.login } });
    if (!user) return void res.status(404).json({ error: 'Not a member' });
    const owners = await prisma.membership.count({
      where: { projectId: req.params.id, role: 'owner' },
    });
    const target = await prisma.membership.findUnique({
      where: { userId_projectId: { userId: user.id, projectId: req.params.id } },
    });
    if (!target) return void res.status(404).json({ error: 'Not a member' });
    if (target.role === 'owner' && owners <= 1) {
      return void res.status(409).json({ error: 'A project needs at least one owner.' });
    }
    await prisma.membership.delete({
      where: { userId_projectId: { userId: user.id, projectId: req.params.id } },
    });
    await audit.fromRequest(req, {
      action: 'member.remove',
      projectId: req.params.id,
      target: user.login,
    });
    res.json({ ok: true });
  });

  app.get('/api/projects/:id/audit', async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = await prisma.auditLog.findMany({
      where: { projectId: req.params.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json(
      rows.map(({ metadataJson, ...r }) => ({
        ...r,
        metadata: metadataJson ? JSON.parse(metadataJson) : null,
      })),
    );
  });

  /** Server-wide audit (admins). */
  app.get('/api/audit', async (req, res) => {
    if (!req.principal || !isAdmin(req.principal))
      return void res.status(403).json({ error: 'Admins only' });
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(rows);
  });
}
