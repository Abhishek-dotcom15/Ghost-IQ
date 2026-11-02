import type { ElementLocator } from '@ghostiq/shared';
import type { Express } from 'express';
import type { PrismaClient } from '../db.js';
import { exportPlaywrightSpec } from './spec.js';

/** Approved heals for a recorded run, by step: these replace the recorded locators on export. */
export async function approvedOverrides(prisma: PrismaClient, sessionId: string) {
  const heals = await prisma.healEvent.findMany({
    where: { sourceSessionId: sessionId, status: 'approved' },
    orderBy: { decidedAt: 'asc' },
  });
  return new Map(heals.map((h) => [h.stepNumber, JSON.parse(h.newLocatorJson) as ElementLocator]));
}

export function registerExportRoutes(app: Express, prisma: PrismaClient) {
  /** Download the run as a plain Playwright test (.spec.ts). `?format=json` returns metadata too. */
  app.get('/api/sessions/:id/export/spec', async (req, res) => {
    const session = await prisma.testSession.findUnique({
      where: { id: req.params.id },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.mode === 'replay' && session.replayOfId) {
      res
        .status(400)
        .json({ error: `Export the recorded run (${session.replayOfId}), not a replay of it.` });
      return;
    }
    const result = exportPlaywrightSpec(
      session,
      session.steps,
      await approvedOverrides(prisma, session.id),
    );
    if (req.query.format === 'json') {
      res.json(result);
      return;
    }
    const slug = (session.goal ?? session.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="ghostiq-${slug || 'run'}.spec.ts"`);
    res.send(result.code);
  });
}
