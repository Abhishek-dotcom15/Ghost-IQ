import type { IncomingHttpHeaders } from 'node:http';
import type { PrismaClient } from '../db.js';
import { authEnabled, type Env } from '../env.js';
import { API_KEY_PREFIX, parseCookies, safeEqual, sha256 } from './tokens.js';

export const SESSION_COOKIE = 'ghostiq_session';

/** Who is calling. */
export type Principal =
  /** Authentication is off (single-user local install): full access. */
  | { kind: 'local' }
  | { kind: 'admin_token' }
  | { kind: 'user'; user: { id: string; login: string; admin: boolean } }
  | { kind: 'api_key'; keyId: string; projectId: string; name: string }
  | { kind: 'anonymous' };

export function principalLabel(p: Principal): string {
  switch (p.kind) {
    case 'user':
      return p.user.login;
    case 'api_key':
      return `key:${p.name}`;
    case 'admin_token':
      return 'admin-token';
    case 'local':
      return 'local';
    case 'anonymous':
      return 'anonymous';
  }
}

export function principalId(p: Principal): string | null {
  if (p.kind === 'user') return p.user.id;
  if (p.kind === 'api_key') return p.keyId;
  return null;
}

/** Everything a human signed-in principal may do that keys and anonymous visitors may not. */
export function isHuman(p: Principal): boolean {
  return p.kind === 'user' || p.kind === 'admin_token' || p.kind === 'local';
}

export function isAdmin(p: Principal): boolean {
  return p.kind === 'local' || p.kind === 'admin_token' || (p.kind === 'user' && p.user.admin);
}

const KEY_TOUCH_INTERVAL_MS = 5 * 60_000;

/**
 * Resolves the caller from a session cookie, a bearer token (project API key or the admin
 * token) or nothing (anonymous). With authentication off everyone is `local`.
 */
export class Authenticator {
  readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: Env,
  ) {
    this.enabled = authEnabled(env);
  }

  async resolve(input: { cookie?: string; bearer?: string }): Promise<Principal> {
    if (!this.enabled) return { kind: 'local' };
    if (input.bearer) return (await this.fromBearer(input.bearer)) ?? { kind: 'anonymous' };
    const token = parseCookies(input.cookie)[SESSION_COOKIE];
    if (token) {
      const session = await this.prisma.authSession.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: true },
      });
      if (session && session.expiresAt > new Date()) {
        return {
          kind: 'user',
          user: { id: session.user.id, login: session.user.login, admin: session.user.admin },
        };
      }
    }
    return { kind: 'anonymous' };
  }

  fromHeaders(headers: IncomingHttpHeaders, authToken?: unknown): Promise<Principal> {
    const auth = headers.authorization;
    const bearer =
      typeof authToken === 'string' && authToken
        ? authToken
        : typeof auth === 'string' && /^Bearer\s+/i.test(auth)
          ? auth.replace(/^Bearer\s+/i, '').trim()
          : undefined;
    return this.resolve({ cookie: headers.cookie, bearer });
  }

  private async fromBearer(token: string): Promise<Principal | null> {
    if (this.env.GHOSTIQ_ADMIN_TOKEN && safeEqual(token, this.env.GHOSTIQ_ADMIN_TOKEN)) {
      return { kind: 'admin_token' };
    }
    if (!token.startsWith(API_KEY_PREFIX)) return null;
    const key = await this.prisma.apiKey.findUnique({ where: { hash: sha256(token) } });
    if (!key || key.revokedAt) return null;
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > KEY_TOUCH_INTERVAL_MS) {
      void this.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }
    return { kind: 'api_key', keyId: key.id, projectId: key.projectId, name: key.name };
  }
}
