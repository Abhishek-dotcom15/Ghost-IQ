import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from './db.js';
import { applyRetention } from './retention.js';

let prisma: PrismaClient;
const dirs = {
  screenshots: fs.mkdtempSync(path.join(os.tmpdir(), 'gq-ret-shots-')),
  artifacts: fs.mkdtempSync(path.join(os.tmpdir(), 'gq-ret-art-')),
};

beforeAll(() => {
  prisma = createPrismaClient(process.env.TEST_DATABASE_URL ?? '');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('applyRetention', () => {
  it('deletes old runs and their files, but keeps baselines, live runs and referenced evidence', async () => {
    const project = await prisma.project.create({ data: { name: 'Retention' } });
    const old = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-03-01T00:00:00Z');
    const mk = (over: Record<string, unknown>) =>
      prisma.testSession.create({
        data: {
          projectId: project.id,
          name: 'r',
          targetUrl: 'http://a.test',
          persona: 'P',
          status: 'PASSED',
          startedAt: old,
          ...over,
        },
      });
    const expired = await mk({});
    const baseline = await mk({ isBaseline: true });
    const running = await mk({ status: 'RUNNING' });
    const recent = await mk({ startedAt: new Date('2026-02-25T00:00:00Z') });
    await prisma.testStep.create({
      data: {
        sessionId: expired.id,
        stepNumber: 1,
        action: 'GOTO',
        description: 'x',
        status: 'PASSED',
      },
    });

    for (const s of [expired, baseline, running, recent]) {
      fs.writeFileSync(path.join(dirs.screenshots, `${s.id}_1.png`), 'png');
      fs.writeFileSync(path.join(dirs.screenshots, `${s.id}_2.png`), 'png');
    }
    fs.mkdirSync(path.join(dirs.artifacts, expired.id));
    fs.writeFileSync(path.join(dirs.artifacts, expired.id, 'trace.zip'), 'zip');
    // A finding still shows step 2's screenshot of the expired run as evidence.
    await prisma.finding.create({
      data: {
        projectId: project.id,
        fingerprint: `ret-${expired.id}`,
        type: 'runtime_error',
        severity: 'high',
        title: 't',
        route: '/',
        message: 'm',
        evidenceJson: JSON.stringify({ screenshot: `/screenshots/${expired.id}_2.png` }),
        reproJson: '[]',
        personasJson: '[]',
        firstSessionId: expired.id,
        lastSessionId: expired.id,
      },
    });

    const result = await applyRetention(prisma, dirs, 30, now);
    expect(result).toEqual({ sessions: 1, files: 2, keptFiles: 1 });
    expect(await prisma.testSession.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.testStep.count({ where: { sessionId: expired.id } })).toBe(0);
    for (const s of [baseline, running, recent]) {
      expect(await prisma.testSession.findUnique({ where: { id: s.id } })).not.toBeNull();
    }
    expect(fs.existsSync(path.join(dirs.screenshots, `${expired.id}_1.png`))).toBe(false);
    expect(fs.existsSync(path.join(dirs.screenshots, `${expired.id}_2.png`))).toBe(true); // evidence
    expect(fs.existsSync(path.join(dirs.artifacts, expired.id))).toBe(false);
    expect(fs.existsSync(path.join(dirs.screenshots, `${baseline.id}_1.png`))).toBe(true);
    expect(await prisma.finding.count({ where: { fingerprint: `ret-${expired.id}` } })).toBe(1);
  });
});
