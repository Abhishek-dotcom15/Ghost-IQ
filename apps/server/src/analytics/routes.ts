import type { Express } from 'express';
import type { PrismaClient } from '../db.js';
import { computeAnalytics } from './compute.js';

const MAX_REQUESTS = 20_000;

export function registerAnalyticsRoutes(app: Express, prisma: PrismaClient) {
  /** Coverage, persona effectiveness, findings over time, cost per finding, endpoint latency. */
  app.get('/api/projects/:id/analytics', async (req, res) => {
    const projectId = req.params.id;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const sessions = await prisma.testSession.findMany({
      where: { projectId, startedAt: { gte: since } },
      select: {
        id: true,
        name: true,
        persona: true,
        mode: true,
        replayOfId: true,
        status: true,
        endReason: true,
        startedAt: true,
        flakinessScore: true,
        steps: { select: { stepNumber: true, url: true } },
      },
    });
    const ids = sessions.map((s) => s.id);
    const [costs, findings, occurrences, requests, heals] = await Promise.all([
      prisma.llmCall.groupBy({
        by: ['sessionId'],
        where: { sessionId: { in: ids } },
        _sum: { costUsd: true },
      }),
      prisma.finding.findMany({
        where: { projectId, firstSeenAt: { gte: since } },
        select: { id: true, severity: true, status: true, firstSeenAt: true },
      }),
      prisma.findingOccurrence.findMany({
        where: { sessionId: { in: ids } },
        select: { findingId: true, sessionId: true },
      }),
      prisma.networkRequest.findMany({
        where: { step: { sessionId: { in: ids } } },
        select: { method: true, url: true, status: true, latencyMs: true },
        orderBy: { timestamp: 'desc' },
        take: MAX_REQUESTS,
      }),
      prisma.healEvent.findMany({ where: { projectId }, select: { status: true, method: true } }),
    ]);

    res.json({
      days,
      ...computeAnalytics({
        sessions,
        costBySession: new Map(
          costs.filter((c) => c.sessionId).map((c) => [c.sessionId!, c._sum.costUsd ?? 0]),
        ),
        findings,
        occurrences,
        requests,
        heals,
        days,
        now: new Date(),
      }),
    });
  });
}
