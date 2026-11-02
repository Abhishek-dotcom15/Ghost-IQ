import type { Request } from 'express';
import type { PrismaClient } from '../db.js';
import { principalId, principalLabel, type Principal } from './principal.js';

export interface AuditEntry {
  action: string;
  projectId?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

/** Records security-relevant actions. Never throws: auditing must not break the action. */
export class AuditLog {
  constructor(private readonly prisma: PrismaClient) {}

  async record(actor: Principal, entry: AuditEntry, ip?: string | null) {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          projectId: entry.projectId ?? null,
          target: entry.target ?? null,
          metadataJson: entry.metadata ? JSON.stringify(entry.metadata).slice(0, 4000) : null,
          actorType: actor.kind,
          actorId: principalId(actor),
          actorLabel: principalLabel(actor),
          ip: ip ?? null,
        },
      });
    } catch (err) {
      console.error('[audit] failed to record', entry.action, err);
    }
  }

  /** Convenience for route handlers. */
  fromRequest(req: Request, entry: AuditEntry) {
    return this.record(req.principal ?? { kind: 'anonymous' }, entry, req.ip);
  }
}
