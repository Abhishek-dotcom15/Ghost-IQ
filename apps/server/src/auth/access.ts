import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '../db.js';
import { isAdmin, isHuman, type Authenticator, type Principal } from './principal.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's documented augmentation point
  namespace Express {
    interface Request {
      principal?: Principal;
      /** The project this request acts on, when the access rules resolved one. */
      projectId?: string;
    }
  }
}

export type Need = 'read' | 'write' | 'owner';
export const ROLES = ['owner', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Need, number> = { read: 1, write: 2, owner: 3 };
const ROLE_GRANTS: Record<Role, number> = { viewer: 1, member: 2, owner: 3 };

/** The access level a principal has on a project: 0 none, 1 read, 2 write, 3 owner. */
export async function accessLevel(
  prisma: PrismaClient,
  principal: Principal,
  projectId: string,
): Promise<number> {
  if (isAdmin(principal)) return 3;
  if (principal.kind === 'api_key') return principal.projectId === projectId ? 2 : 0;
  let level = 0;
  if (principal.kind === 'user') {
    const m = await prisma.membership.findUnique({
      where: { userId_projectId: { userId: principal.user.id, projectId } },
    });
    if (m) level = ROLE_GRANTS[m.role as Role] ?? 0;
  }
  if (level === 0) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { public: true },
    });
    if (project?.public) level = 1;
  }
  return level;
}

export async function can(
  prisma: PrismaClient,
  principal: Principal,
  projectId: string,
  need: Need,
) {
  return (await accessLevel(prisma, principal, projectId)) >= RANK[need];
}

/** Projects the principal may list (null = all). */
export async function visibleProjectIds(
  prisma: PrismaClient,
  principal: Principal,
): Promise<string[] | null> {
  if (isAdmin(principal)) return null;
  if (principal.kind === 'api_key') return [principal.projectId];
  const publicIds = (
    await prisma.project.findMany({ where: { public: true }, select: { id: true } })
  ).map((p) => p.id);
  if (principal.kind !== 'user') return publicIds;
  const mine = (
    await prisma.membership.findMany({
      where: { userId: principal.user.id },
      select: { projectId: true },
    })
  ).map((m) => m.projectId);
  return [...new Set([...mine, ...publicIds])];
}

type Requirement =
  /** Anyone, including anonymous visitors. */
  | { kind: 'open' }
  /** Any signed-in human (user, admin token, local). */
  | { kind: 'human' }
  /** Any authenticated principal (human or API key). */
  | { kind: 'authenticated' }
  | { kind: 'project'; projectId: string | null; need: Need };

const UUIDISH = '[A-Za-z0-9-]{1,64}';

/**
 * Maps each request to what it needs. Deny by default: an /api route missing here needs a
 * signed-in human. Unknown project/session/finding ids resolve to "no access" (404, so
 * existence is not leaked).
 */
export async function requirementFor(prisma: PrismaClient, req: Request): Promise<Requirement> {
  const p = req.path;
  const m = req.method;
  const read = m === 'GET' || m === 'HEAD';
  const sessionProject = async (id: string) =>
    (await prisma.testSession.findUnique({ where: { id }, select: { projectId: true } }))
      ?.projectId ?? null;

  if (p === '/healthz' || p.startsWith('/auth/') || p === '/api/me') return { kind: 'open' };
  if (!p.startsWith('/api/') && !p.startsWith('/screenshots/') && !p.startsWith('/artifacts/')) {
    return { kind: 'open' }; // dashboard assets and SPA routes
  }

  // Evidence files are named after their run (or project for baselines).
  let match = p.match(new RegExp(`^/screenshots/(${UUIDISH})_\\d+\\.png$`));
  if (match) return { kind: 'project', projectId: await sessionProject(match[1]!), need: 'read' };
  match = p.match(new RegExp(`^/artifacts/baselines/(${UUIDISH})/`));
  if (match) return { kind: 'project', projectId: match[1]!, need: 'read' };
  match = p.match(new RegExp(`^/artifacts/(${UUIDISH})/`));
  if (match) return { kind: 'project', projectId: await sessionProject(match[1]!), need: 'read' };
  if (p.startsWith('/screenshots/') || p.startsWith('/artifacts/')) return { kind: 'human' };

  if (p === '/api/personas' || p.startsWith('/api/personas/')) {
    if (read) return { kind: 'open' };
    if (p === '/api/personas/validate') return { kind: 'authenticated' };
    return { kind: 'human' };
  }
  if (p === '/api/projects') return read ? { kind: 'open' } : { kind: 'human' }; // list is filtered
  match = p.match(new RegExp(`^/api/projects/(${UUIDISH})(/[^/]+)?`));
  if (match) {
    const sub = match[2] ?? '';
    const ownerOnly = ['/keys', '/members', '/audit'].includes(sub) || (!sub && !read);
    return {
      kind: 'project',
      projectId: match[1]!,
      need: ownerOnly ? 'owner' : read ? 'read' : 'write',
    };
  }
  if (p === '/api/sessions' && m === 'POST') {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : null;
    return { kind: 'project', projectId, need: 'write' };
  }
  match = p.match(new RegExp(`^/api/sessions/(${UUIDISH})`));
  if (match)
    return {
      kind: 'project',
      projectId: await sessionProject(match[1]!),
      need: read ? 'read' : 'write',
    };
  match = p.match(new RegExp(`^/api/findings/(${UUIDISH})`));
  if (match) {
    const f = await prisma.finding.findUnique({
      where: { id: match[1]! },
      select: { projectId: true },
    });
    return { kind: 'project', projectId: f?.projectId ?? null, need: read ? 'read' : 'write' };
  }
  match = p.match(new RegExp(`^/api/heals/(${UUIDISH})`));
  if (match) {
    const h = await prisma.healEvent.findUnique({
      where: { id: match[1]! },
      select: { projectId: true },
    });
    return { kind: 'project', projectId: h?.projectId ?? null, need: read ? 'read' : 'write' };
  }
  match = p.match(new RegExp(`^/api/keys/(${UUIDISH})$`));
  if (match) {
    const k = await prisma.apiKey.findUnique({
      where: { id: match[1]! },
      select: { projectId: true },
    });
    return { kind: 'project', projectId: k?.projectId ?? null, need: 'owner' };
  }
  if (p.startsWith('/api/ai/')) {
    // The planner spends LLM credits: only for a run in progress, by someone who may run it.
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const s = sessionId
      ? await prisma.testSession.findUnique({
          where: { id: sessionId },
          select: { projectId: true, status: true },
        })
      : null;
    return {
      kind: 'project',
      projectId: s && s.status === 'RUNNING' ? s.projectId : null,
      need: 'write',
    };
  }
  if (p === '/api/llm/status') return { kind: 'authenticated' };
  return { kind: 'human' };
}

/** Express middleware: authenticates the caller, then enforces `requirementFor`. */
export function authorize(prisma: PrismaClient, auth: Authenticator) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = await auth.fromHeaders(req.headers);
      req.principal = principal;
      const need = await requirementFor(prisma, req);
      if (need.kind === 'project' && need.projectId) req.projectId = need.projectId;
      if (!auth.enabled) return next();

      if (need.kind === 'open') return next();
      if (principal.kind === 'anonymous' && need.kind !== 'project') {
        return void res.status(401).json({ error: 'Sign in required' });
      }
      if (need.kind === 'authenticated') return next();
      if (need.kind === 'human') {
        return isHuman(principal)
          ? next()
          : void res.status(403).json({ error: 'This needs a signed-in user, not an API key' });
      }
      const level = need.projectId ? await accessLevel(prisma, principal, need.projectId) : 0;
      if (level === 0) {
        // Same answer whether the thing does not exist or is not yours.
        return void res.status(principal.kind === 'anonymous' ? 401 : 404).json({
          error: principal.kind === 'anonymous' ? 'Sign in required' : 'Not found',
        });
      }
      if (level < RANK[need.need]) {
        return void res.status(403).json({
          error: need.need === 'owner' ? 'Only project owners can do this' : 'Read-only access',
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * CSRF: cookie-authenticated state changes must come from our own origin. SameSite=Lax
 * already blocks most cross-site requests; this closes the remaining gaps.
 */
export function sameOriginForCookieWrites(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.headers.authorization) return next(); // bearer tokens are not sent automatically
    if (!req.headers.cookie) return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser client
    const self = `${req.protocol}://${req.get('host')}`;
    if (origin === self || allowedOrigins.includes(origin)) return next();
    res.status(403).json({ error: 'Cross-origin request refused' });
  };
}
