import type { NextFunction, Request, Response } from 'express';
import type { AuditLog } from './audit.js';

/** State-changing routes recorded in the audit log once they succeed. */
const ACTIONS: Array<[string, RegExp, string]> = [
  ['POST', /^\/api\/sessions$/, 'run.start'],
  ['POST', /^\/api\/sessions\/[^/]+\/cancel$/, 'run.cancel'],
  ['POST', /^\/api\/sessions\/[^/]+\/replay$/, 'run.replay'],
  ['POST', /^\/api\/sessions\/[^/]+\/set-baseline$/, 'baseline.set'],
  ['PATCH', /^\/api\/findings\/[^/]+$/, 'finding.triage'],
  ['POST', /^\/api\/heals\/[^/]+\/decision$/, 'heal.decide'],
  ['POST', /^\/api\/personas$/, 'persona.create'],
  ['PUT', /^\/api\/personas\/[^/]+$/, 'persona.update'],
  ['DELETE', /^\/api\/personas\/[^/]+$/, 'persona.delete'],
  ['POST', /^\/api\/projects\/[^/]+\/export-pr$/, 'project.export_pr'],
];

export function auditActionFor(method: string, path: string): string | null {
  return ACTIONS.find(([m, re]) => m === method && re.test(path))?.[2] ?? null;
}

/** Small, non-secret summary of the request body for the log. */
function summarize(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const keep = ['personaId', 'targetUrl', 'goal', 'status', 'runs', 'seed', 'note'];
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    const v = (body as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function auditTrail(audit: AuditLog) {
  return (req: Request, res: Response, next: NextFunction) => {
    const action = auditActionFor(req.method, req.path);
    if (action) {
      const path = req.path;
      const metadata = summarize(req.body);
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        void audit.fromRequest(req, {
          action,
          projectId:
            req.projectId ?? (typeof req.body?.projectId === 'string' ? req.body.projectId : null),
          target: path,
          metadata,
        });
      });
    }
    next();
  };
}
