import type { NextFunction, Request, Response } from 'express';
import { principalId } from '../auth/principal.js';

export interface Bucket {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window limiter in memory (one server process). Keys are the caller (user or API
 * key) when known, else the client IP, so one noisy runner cannot starve everyone else.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns seconds to wait, or 0 when the request is allowed. */
  take(key: string, bucket: Bucket): { allowed: boolean; remaining: number; retryAfterS: number } {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + bucket.windowMs };
      this.hits.set(key, entry);
      if (this.hits.size > 50_000) this.sweep(t);
    }
    entry.count++;
    const allowed = entry.count <= bucket.limit;
    return {
      allowed,
      remaining: Math.max(0, bucket.limit - entry.count),
      retryAfterS: allowed ? 0 : Math.ceil((entry.resetAt - t) / 1000),
    };
  }

  private sweep(t: number) {
    for (const [key, entry] of this.hits) if (entry.resetAt <= t) this.hits.delete(key);
  }
}

export const BUCKETS = {
  /** Sign-in endpoints: per IP, slows down token guessing. */
  auth: { limit: 20, windowMs: 60_000 },
  /** Planner/heal calls: about one per agent step. */
  ai: { limit: 300, windowMs: 60_000 },
  api: { limit: 1200, windowMs: 60_000 },
} as const satisfies Record<string, Bucket>;

export function bucketFor(path: string): keyof typeof BUCKETS | null {
  if (path.startsWith('/auth/')) return 'auth';
  if (path.startsWith('/api/ai/')) return 'ai';
  if (path.startsWith('/api/')) return 'api';
  return null;
}

export function rateLimit(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction) => {
    const name = bucketFor(req.path);
    if (!name) return next();
    const bucket = BUCKETS[name];
    const who = name === 'auth' ? null : req.principal ? principalId(req.principal) : null;
    const key = `${name}:${who ?? `ip:${req.ip}`}`;
    const result = limiter.take(key, bucket);
    res.setHeader('RateLimit-Limit', String(bucket.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterS));
      res.status(429).json({ error: `Too many requests; retry in ${result.retryAfterS} s` });
      return;
    }
    next();
  };
}
