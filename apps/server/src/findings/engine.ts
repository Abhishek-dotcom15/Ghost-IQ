import fs from 'node:fs';
import path from 'node:path';
import { SEVERITY_RANK, normalizeRoute, type Severity, type StepIssue } from '@ghostiq/shared';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { PrismaClient } from '../db.js';
import {
  fingerprint,
  issueToFinding,
  slowEndpointFindings,
  validationFindings,
  type RawFinding,
  type StepForValidation,
} from './classify.js';

/** Share of differing pixels above which a page counts as visually changed. */
export const VISUAL_DIFF_RATIO = 0.02;

export interface SessionRef {
  id: string;
  projectId: string;
  persona: string;
}

export interface StepRef {
  stepNumber: number;
  url: string | null;
  screenshotPath: string | null;
}

export interface Evidence {
  sessionId: string;
  stepNumber: number | null;
  pageUrl: string | null;
  screenshot: string | null;
  message: string;
  detail?: string;
  request?: RawFinding['request'];
  diffImage?: string;
  baselineImage?: string;
}

export interface FindingChange {
  id: string;
  isNew: boolean;
  regressed: boolean;
}

/**
 * Turns raw step issues into deduplicated Findings. Dismissed findings stay dismissed when
 * they recur (that is how false positives are remembered); fixed ones reopen (regression).
 */
export class FindingsEngine {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dirs: { screenshots: string; artifacts: string },
  ) {}

  /** Called for every stored step. Returns the findings created or updated. */
  async recordStep(
    session: SessionRef,
    step: StepRef,
    issues: StepIssue[],
  ): Promise<FindingChange[]> {
    const pageUrl = step.url ?? '';
    const changes: FindingChange[] = [];
    for (const issue of issues) {
      const raw = issueToFinding(issue, pageUrl);
      if (raw) changes.push(await this.upsert(session, raw, step));
    }
    const visual = await this.compareVisual(session, step).catch((err: unknown) => {
      console.warn('[findings] visual comparison failed:', (err as Error).message);
      return null;
    });
    if (visual) changes.push(await this.upsert(session, visual.finding, step, visual.images));
    return changes;
  }

  /**
   * Run-level oracles that need the whole run: slow endpoints and accepted invalid input.
   * `throttled`: the persona simulated a slow network, so latency says nothing about the app.
   */
  async finalizeSession(
    sessionId: string,
    options: { throttled?: boolean } = {},
  ): Promise<FindingChange[]> {
    const session = await this.prisma.testSession.findUnique({
      where: { id: sessionId },
      include: { steps: { orderBy: { stepNumber: 'asc' }, include: { networkLogs: true } } },
    });
    if (!session) return [];
    const ref = { id: session.id, projectId: session.projectId, persona: session.persona };
    const changes: FindingChange[] = [];

    const samples = session.steps.flatMap((s) =>
      s.networkLogs.map((n) => ({
        method: n.method,
        url: n.url,
        status: n.status,
        latencyMs: n.latencyMs,
        stepNumber: s.stepNumber,
      })),
    );
    for (const raw of options.throttled ? [] : slowEndpointFindings(samples)) {
      const first = samples.find((s) => normalizeRoute(s.url) === raw.route && s.latencyMs > 0);
      const step = session.steps.find((s) => s.stepNumber === first?.stepNumber);
      changes.push(
        await this.upsert(ref, raw, step ?? { stepNumber: 0, url: null, screenshotPath: null }),
      );
    }

    const forValidation: StepForValidation[] = session.steps.map((s) => ({
      stepNumber: s.stepNumber,
      action: s.action,
      value: s.value,
      input: s.inputJson ? JSON.parse(s.inputJson) : null,
      network: s.networkLogs,
    }));
    for (const raw of validationFindings(forValidation)) {
      const step = session.steps.find((s) => s.stepNumber === raw.stepNumber)!;
      changes.push(await this.upsert(ref, raw, step));
    }
    return changes;
  }

  private async upsert(
    session: SessionRef,
    raw: RawFinding,
    step: StepRef,
    images?: { diffImage: string; baselineImage: string },
  ): Promise<FindingChange> {
    const fp = fingerprint(raw);
    const evidence: Evidence = {
      sessionId: session.id,
      stepNumber: step.stepNumber || null,
      pageUrl: step.url,
      screenshot: step.screenshotPath,
      message: raw.message,
      detail: raw.detail,
      request: raw.request,
      ...images,
    };
    const key = { projectId_fingerprint: { projectId: session.projectId, fingerprint: fp } };
    const existing = await this.prisma.finding.findUnique({ where: key });

    let id: string;
    let isNew = false;
    let regressed = false;
    if (!existing) {
      const created = await this.prisma.finding.create({
        data: {
          projectId: session.projectId,
          fingerprint: fp,
          type: raw.type,
          severity: raw.severity,
          title: raw.title,
          route: raw.route,
          rule: raw.rule ?? null,
          message: raw.message,
          confidence: raw.confidence,
          evidenceJson: JSON.stringify(evidence),
          reproJson: JSON.stringify(await this.reproSteps(session.id, step.stepNumber)),
          personasJson: JSON.stringify([session.persona]),
          firstSessionId: session.id,
          lastSessionId: session.id,
        },
      });
      id = created.id;
      isNew = true;
    } else {
      const personas = new Set<string>(JSON.parse(existing.personasJson));
      personas.add(session.persona);
      regressed = existing.status === 'fixed';
      await this.prisma.finding.update({
        where: { id: existing.id },
        data: {
          recurrences: existing.recurrences + 1,
          lastSeenAt: new Date(),
          lastSessionId: session.id,
          evidenceJson: JSON.stringify(evidence),
          personasJson: JSON.stringify([...personas]),
          severity: worse(existing.severity as Severity, raw.severity),
          ...(regressed
            ? { status: 'open', triageNote: `Regressed: seen again in run ${session.id}` }
            : {}),
        },
      });
      id = existing.id;
    }
    await this.prisma.findingOccurrence.create({
      data: {
        findingId: id,
        sessionId: session.id,
        stepNumber: step.stepNumber || null,
        persona: session.persona,
      },
    });
    return { id, isNew, regressed };
  }

  /** "1. Open http://...", "2. Fill textbox "Email" with "a@b"", ... up to the failing step. */
  private async reproSteps(sessionId: string, upTo: number): Promise<string[]> {
    const steps = await this.prisma.testStep.findMany({
      where: { sessionId, ...(upTo > 0 ? { stepNumber: { lte: upTo } } : {}) },
      orderBy: { stepNumber: 'asc' },
      select: { stepNumber: true, description: true, value: true, status: true },
    });
    return steps.map(
      (s) =>
        `${s.stepNumber}. ${s.description}${s.value ? ` with ${JSON.stringify(s.value)}` : ''}${s.status === 'PASSED' ? '' : ` [${s.status}]`}`,
    );
  }

  // ------------------------------------------------------------- visual regression

  /** Copies a run's page-arrival screenshots into the project's baseline set. */
  async captureBaseline(sessionId: string): Promise<number> {
    const session = await this.prisma.testSession.findUnique({
      where: { id: sessionId },
      include: { steps: { orderBy: { stepNumber: 'asc' } } },
    });
    if (!session) return 0;
    const dir = path.join(this.dirs.artifacts, 'baselines', session.projectId);
    await fs.promises.mkdir(dir, { recursive: true });
    let previousUrl: string | null = null;
    let stored = 0;
    const seen = new Set<string>();
    for (const step of session.steps) {
      const arrived = step.url !== previousUrl;
      previousUrl = step.url;
      if (!arrived || !step.url || !step.screenshotPath || !/^https?:/.test(step.url)) continue;
      const file = this.screenshotFile(step.screenshotPath);
      const buffer = await fs.promises.readFile(file).catch(() => null);
      if (!buffer) continue;
      const pageKey = `${pagePath(step.url)}|${pngSize(buffer)}`;
      if (seen.has(pageKey)) continue;
      seen.add(pageKey);
      const target = path.join(dir, `${encodeURIComponent(pageKey)}.png`);
      await fs.promises.writeFile(target, buffer);
      await this.prisma.baselineImage.upsert({
        where: { projectId_pageKey: { projectId: session.projectId, pageKey } },
        create: { projectId: session.projectId, pageKey, path: target, sessionId },
        update: { path: target, sessionId, createdAt: new Date() },
      });
      stored++;
    }
    return stored;
  }

  /** Compares a page-arrival screenshot with the baseline for the same route and size. */
  private async compareVisual(session: SessionRef, step: StepRef) {
    if (!step.url || !step.screenshotPath || !/^https?:/.test(step.url)) return null;
    const previous = await this.prisma.testStep.findFirst({
      where: { sessionId: session.id, stepNumber: { lt: step.stepNumber } },
      orderBy: { stepNumber: 'desc' },
      select: { url: true },
    });
    if (previous && previous.url === step.url) return null; // only fresh page loads

    const current = await fs.promises
      .readFile(this.screenshotFile(step.screenshotPath))
      .catch(() => null);
    if (!current) return null;
    const route = normalizeRoute(step.url);
    const pageKey = `${pagePath(step.url)}|${pngSize(current)}`;
    const baseline = await this.prisma.baselineImage.findUnique({
      where: { projectId_pageKey: { projectId: session.projectId, pageKey } },
    });
    if (!baseline || baseline.sessionId === session.id) return null;
    const reference = await fs.promises.readFile(baseline.path).catch(() => null);
    if (!reference) return null;

    const a = PNG.sync.read(reference);
    const b = PNG.sync.read(current);
    if (a.width !== b.width || a.height !== b.height) return null;
    const diff = new PNG({ width: a.width, height: a.height });
    const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const ratio = changed / (a.width * a.height);
    if (ratio <= VISUAL_DIFF_RATIO) return null;

    const dir = path.join(this.dirs.artifacts, session.id);
    await fs.promises.mkdir(dir, { recursive: true });
    const diffName = `visual-diff-${step.stepNumber}.png`;
    await fs.promises.writeFile(path.join(dir, diffName), PNG.sync.write(diff));
    const finding: RawFinding = {
      type: 'visual_regression',
      severity: ratio > 0.1 ? 'medium' : 'low',
      route,
      title: `${route} looks different from the baseline (${(ratio * 100).toFixed(1)}% of pixels)`,
      message: `${changed} of ${a.width * a.height} pixels differ from the baseline screenshot (threshold ${VISUAL_DIFF_RATIO * 100}%).`,
      confidence: 'suspected',
      detail: `${(ratio * 100).toFixed(2)}% changed`,
    };
    return {
      finding,
      images: {
        diffImage: `/artifacts/${session.id}/${diffName}`,
        baselineImage: `/artifacts/baselines/${session.projectId}/${encodeURIComponent(encodeURIComponent(pageKey))}.png`,
      },
    };
  }

  private screenshotFile(publicPath: string): string {
    return path.join(this.dirs.screenshots, path.basename(publicPath));
  }
}

function worse(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** Exact path: /products/1 and /products/3 are different pages even if the route matches. */
function pagePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** "1280x720" from a PNG header (width and height are big-endian at bytes 16-23). */
function pngSize(buffer: Buffer): string {
  if (buffer.length < 24) return 'unknown';
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}
