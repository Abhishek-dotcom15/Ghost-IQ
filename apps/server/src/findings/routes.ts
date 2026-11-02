import {
  FINDING_STATUSES,
  FINDING_TYPES,
  FindingTriage,
  SEVERITIES,
  type FindingType,
  type Severity,
} from '@ghostiq/shared';
import type { Express } from 'express';
import type { PrismaClient } from '../db.js';
import type { Evidence } from './engine.js';
import {
  REPORT_FORMATS,
  countBySeverity,
  renderReport,
  sortFindings,
  type FindingView,
  type ReportFormat,
} from './reports.js';

interface FindingRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  route: string;
  rule: string | null;
  message: string;
  confidence: string;
  status: string;
  triageNote: string | null;
  recurrences: number;
  personasJson: string;
  evidenceJson: string;
  reproJson: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export function toView(row: FindingRow): FindingView {
  return {
    id: row.id,
    type: row.type as FindingType,
    severity: row.severity as Severity,
    title: row.title,
    route: row.route,
    rule: row.rule,
    message: row.message,
    confidence: row.confidence as FindingView['confidence'],
    status: row.status,
    triageNote: row.triageNote,
    recurrences: row.recurrences,
    personas: JSON.parse(row.personasJson) as string[],
    evidence: JSON.parse(row.evidenceJson) as Evidence,
    repro: JSON.parse(row.reproJson) as string[],
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/**
 * Per-persona yield: how many findings each persona hit, and how many only it found.
 * This is the product's core story ("the Impatient User found 3 issues nobody else did").
 */
export function personaBreakdown(findings: FindingView[]) {
  const stats = new Map<string, { persona: string; total: number; unique: number }>();
  for (const f of findings) {
    for (const persona of f.personas) {
      const s = stats.get(persona) ?? { persona, total: 0, unique: 0 };
      s.total++;
      if (f.personas.length === 1) s.unique++;
      stats.set(persona, s);
    }
  }
  return [...stats.values()].sort((a, b) => b.unique - a.unique || b.total - a.total);
}

function summarize(findings: FindingView[]) {
  const byType: Record<string, number> = {};
  for (const f of findings) byType[f.type] = (byType[f.type] ?? 0) + 1;
  return {
    total: findings.length,
    bySeverity: countBySeverity(findings),
    byType,
    byPersona: personaBreakdown(findings),
  };
}

const list = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && value
    ? value.split(',').filter((v) => allowed.includes(v))
    : undefined;

export function registerFindingRoutes(app: Express, prisma: PrismaClient) {
  app.get('/api/projects/:id/findings', async (req, res) => {
    const status = list(req.query.status, FINDING_STATUSES);
    const severity = list(req.query.severity, SEVERITIES);
    const type = list(req.query.type, FINDING_TYPES);
    const rows = await prisma.finding.findMany({
      where: {
        projectId: req.params.id,
        ...(status ? { status: { in: status } } : {}),
        ...(severity ? { severity: { in: severity } } : {}),
        ...(type ? { type: { in: type } } : {}),
      },
    });
    let findings = rows.map(toView);
    const persona = typeof req.query.persona === 'string' ? req.query.persona : undefined;
    if (persona) findings = findings.filter((f) => f.personas.includes(persona));
    findings = sortFindings(findings);
    res.json({ findings, summary: summarize(findings) });
  });

  app.get('/api/findings/:id', async (req, res) => {
    const row = await prisma.finding.findUnique({
      where: { id: req.params.id },
      include: { occurrences: { orderBy: { createdAt: 'desc' }, take: 50 } },
    });
    if (!row) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    res.json({ ...toView(row), occurrences: row.occurrences });
  });

  app.patch('/api/findings/:id', async (req, res) => {
    const triage = FindingTriage.safeParse(req.body);
    if (!triage.success) {
      res.status(400).json({ error: `status must be one of ${FINDING_STATUSES.join(', ')}` });
      return;
    }
    const exists = await prisma.finding.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!exists) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    const row = await prisma.finding.update({
      where: { id: req.params.id },
      data: { status: triage.data.status, triageNote: triage.data.note ?? null },
    });
    res.json(toView(row));
  });

  /** Findings that occurred in this run (they may also have occurred elsewhere). */
  app.get('/api/sessions/:id/findings', async (req, res) => {
    const rows = await prisma.finding.findMany({
      where: { occurrences: { some: { sessionId: req.params.id } } },
    });
    const findings = sortFindings(rows.map(toView));
    res.json({ findings, summary: summarize(findings) });
  });

  app.get('/api/sessions/:id/report', async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format) {
      res.status(400).json({ error: `format must be one of ${REPORT_FORMATS.join(', ')}` });
      return;
    }
    const session = await prisma.testSession.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { steps: true } } },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const rows = await prisma.finding.findMany({
      where: { occurrences: { some: { sessionId: session.id } }, status: { not: 'dismissed' } },
    });
    const report = renderReport(
      {
        title: `GhostIQ run: ${session.name}`,
        target: session.targetUrl,
        generatedAt: new Date().toISOString(),
        run: {
          id: session.id,
          persona: session.persona,
          goal: session.goal,
          status: session.status,
          endReason: session.endReason,
          summary: session.summary,
          seed: session.seed,
          traceUrl: session.traceUrl,
          steps: session._count.steps,
        },
        findings: rows.map(toView),
      },
      format,
    );
    send(res, report, `ghostiq-run-${session.id.slice(0, 8)}`);
  });

  /** Open and confirmed findings for the whole project (dismissed and fixed are excluded). */
  app.get('/api/projects/:id/report', async (req, res) => {
    const format = parseFormat(req.query.format);
    if (!format) {
      res.status(400).json({ error: `format must be one of ${REPORT_FORMATS.join(', ')}` });
      return;
    }
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { sessions: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const rows = await prisma.finding.findMany({
      where: { projectId: project.id, status: { in: ['open', 'confirmed'] } },
    });
    const report = renderReport(
      {
        title: `GhostIQ findings: ${project.name}`,
        target: project.sessions[0]?.targetUrl ?? '',
        generatedAt: new Date().toISOString(),
        findings: rows.map(toView),
      },
      format,
    );
    send(res, report, `ghostiq-${project.id.slice(0, 8)}`);
  });
}

function parseFormat(value: unknown): ReportFormat | null {
  const format = typeof value === 'string' ? value : 'json';
  return (REPORT_FORMATS as readonly string[]).includes(format) ? (format as ReportFormat) : null;
}

function send(
  res: import('express').Response,
  report: { body: string; contentType: string; ext: string },
  name: string,
) {
  res.setHeader('content-type', report.contentType);
  if (report.ext !== 'html')
    res.setHeader('content-disposition', `attachment; filename="${name}.${report.ext}"`);
  res.send(report.body);
}
