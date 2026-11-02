import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets are random (192+ bits), so a fast hash is the right tool: there is nothing to
 * brute-force, and a lookup by hash keeps verification O(1). Only hashes are stored.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const API_KEY_PREFIX = 'gq_';

/** A new project API key: the raw value is shown to the user once, never stored. */
export function newApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { raw, hash: sha256(raw), prefix: raw.slice(0, 10) };
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newState(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Minimal Cookie header parser. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function cookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number; secure: boolean; path?: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
