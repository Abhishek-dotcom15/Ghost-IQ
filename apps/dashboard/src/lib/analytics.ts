import type { Severity } from './findings';

export interface Analytics {
  days: number;
  totals: {
    runs: number;
    replays: number;
    replayPassRate: number | null;
    findings: number;
    openFindings: number;
    routes: number;
    costUsd: number;
    costPerFinding: number | null;
  };
  personas: Array<{
    persona: string;
    runs: number;
    goalMet: number;
    routes: number;
    coverage: number;
    findings: number;
    costUsd: number;
    costPerFinding: number | null;
  }>;
  coverage: {
    nodes: Array<{ route: string; visits: number; personas: string[] }>;
    edges: Array<{ from: string; to: string; count: number }>;
  };
  timeline: Array<{ day: string } & Record<Severity, number>>;
  endpoints: Array<{
    method: string;
    route: string;
    calls: number;
    errorRate: number;
    p50: number | null;
    p95: number | null;
  }>;
  heals: { pending: number; approved: number; rejected: number; falseHealRate: number | null };
  flaky: Array<{ id: string; name: string; flakinessScore: number }>;
}

export interface Locator {
  ref: string;
  role: string;
  name: string;
  code: string | null;
}

export interface HealView {
  id: string;
  sessionId: string;
  sourceSessionId: string;
  sourceName: string | null;
  stepNumber: number;
  method: 'fuzzy' | 'llm';
  confidence: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  oldLocator: Locator;
  newLocator: Locator;
  beforeScreenshot: string | null;
  afterScreenshot: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ReplayStats {
  flakinessScore: number;
  passed: number;
  failed: number;
  replays: Array<{
    id: string;
    name: string;
    status: string;
    endReason: string | null;
    summary: string | null;
    startedAt: string;
    healedSteps: number[];
  }>;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const fetchAnalytics = async (projectId: string, days: number) =>
  json<Analytics>(await fetch(`/api/projects/${projectId}/analytics?days=${days}`));

export const fetchHeals = async (projectId: string, status: string) =>
  json<HealView[]>(
    await fetch(`/api/projects/${projectId}/heals${status ? `?status=${status}` : ''}`),
  );

export const decideHeal = async (id: string, status: 'approved' | 'rejected') =>
  json(
    await fetch(`/api/heals/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  );

export const fetchReplayStats = async (sessionId: string) =>
  json<ReplayStats>(await fetch(`/api/sessions/${sessionId}/replays`));

export const startReplays = async (sessionId: string, runs: number) =>
  json<{ sessions: Array<{ id: string }> }>(
    await fetch(`/api/sessions/${sessionId}/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs }),
    }),
  );

export const usd = (n: number | null) =>
  n === null ? '-' : n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
export const pct = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
