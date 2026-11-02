import { normalizeRoute, SEVERITIES, type Severity } from '@ghostiq/shared';

export interface AnalyticsSession {
  id: string;
  persona: string;
  mode: string;
  replayOfId?: string | null;
  status: string;
  endReason: string | null;
  startedAt: Date;
  flakinessScore: number;
  name: string;
  steps: Array<{ stepNumber: number; url: string | null }>;
}

export interface AnalyticsInput {
  sessions: AnalyticsSession[];
  /** LLM spend per session id (USD). */
  costBySession: Map<string, number>;
  findings: Array<{ id: string; severity: string; status: string; firstSeenAt: Date }>;
  /** Finding occurrences: which session (and so which persona) hit which finding. */
  occurrences: Array<{ findingId: string; sessionId: string }>;
  requests: Array<{ method: string; url: string; status: number; latencyMs: number }>;
  heals: Array<{ status: string; method: string }>;
  days: number;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Everything the analytics page shows, from raw rows. Pure, so it is unit-tested. */
export function computeAnalytics(input: AnalyticsInput) {
  const explore = input.sessions.filter((s) => s.mode === 'explore');
  const replays = input.sessions.filter((s) => s.mode === 'replay');
  const personaOf = new Map(input.sessions.map((s) => [s.id, s.persona]));
  const replayed = new Set(replays.map((s) => s.replayOfId).filter(Boolean));

  // ---- coverage graph: routes visited and transitions between them
  const nodes = new Map<string, { route: string; visits: number; personas: Set<string> }>();
  const edges = new Map<string, { from: string; to: string; count: number }>();
  const routesByPersona = new Map<string, Set<string>>();
  for (const s of explore) {
    let previous: string | null = null;
    for (const step of [...s.steps].sort((a, b) => a.stepNumber - b.stepNumber)) {
      if (!step.url || !/^https?:/.test(step.url)) continue;
      const route = normalizeRoute(step.url);
      const node = nodes.get(route) ?? { route, visits: 0, personas: new Set<string>() };
      node.personas.add(s.persona);
      if (route !== previous) node.visits++;
      nodes.set(route, node);
      const routes = routesByPersona.get(s.persona) ?? new Set<string>();
      routes.add(route);
      routesByPersona.set(s.persona, routes);
      if (previous && previous !== route) {
        const key = `${previous} -> ${route}`;
        const edge = edges.get(key) ?? { from: previous, to: route, count: 0 };
        edge.count++;
        edges.set(key, edge);
      }
      previous = route;
    }
  }
  const totalRoutes = nodes.size;

  // ---- persona effectiveness
  const findingsByPersona = new Map<string, Set<string>>();
  for (const o of input.occurrences) {
    const persona = personaOf.get(o.sessionId);
    if (!persona) continue;
    const set = findingsByPersona.get(persona) ?? new Set<string>();
    set.add(o.findingId);
    findingsByPersona.set(persona, set);
  }
  const personaNames = [...new Set(explore.map((s) => s.persona))];
  const personas = personaNames
    .map((name) => {
      const runs = explore.filter((s) => s.persona === name);
      const cost = runs.reduce((sum, s) => sum + (input.costBySession.get(s.id) ?? 0), 0);
      const found = findingsByPersona.get(name)?.size ?? 0;
      return {
        persona: name,
        runs: runs.length,
        goalMet: runs.filter((s) => s.endReason === 'goal_met').length,
        routes: routesByPersona.get(name)?.size ?? 0,
        coverage: totalRoutes ? (routesByPersona.get(name)?.size ?? 0) / totalRoutes : 0,
        findings: found,
        costUsd: cost,
        costPerFinding: found ? cost / found : null,
      };
    })
    .sort((a, b) => b.findings - a.findings || a.persona.localeCompare(b.persona));

  // ---- findings over time (new findings per day, by severity)
  const start = new Date(input.now.getTime() - (input.days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  const timeline = Array.from({ length: input.days }, (_, i) => {
    const day = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return {
      day,
      ...(Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>),
    };
  });
  const byDay = new Map(timeline.map((t) => [t.day, t]));
  for (const f of input.findings) {
    const bucket = byDay.get(f.firstSeenAt.toISOString().slice(0, 10));
    if (bucket && (SEVERITIES as readonly string[]).includes(f.severity))
      bucket[f.severity as Severity]++;
  }

  // ---- endpoints: p50/p95 latency and error rate per route
  const groups = new Map<string, typeof input.requests>();
  for (const r of input.requests) {
    const key = `${r.method} ${normalizeRoute(r.url)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const endpoints = [...groups]
    .map(([key, rs]) => {
      const [method, route] = key.split(' ') as [string, string];
      const latencies = rs
        .filter((r) => r.status > 0)
        .map((r) => r.latencyMs)
        .sort((a, b) => a - b);
      return {
        method,
        route,
        calls: rs.length,
        errorRate: rs.filter((r) => r.status === 0 || r.status >= 500).length / rs.length,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
      };
    })
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
    .slice(0, 25);

  // ---- totals
  const totalCost = [...input.costBySession.values()].reduce((a, b) => a + b, 0);
  const decidedHeals = input.heals.filter((h) => h.status !== 'pending');
  const rejected = decidedHeals.filter((h) => h.status === 'rejected').length;

  return {
    totals: {
      runs: explore.length,
      replays: replays.length,
      replayPassRate: replays.length
        ? replays.filter((r) => r.status === 'PASSED').length / replays.length
        : null,
      findings: input.findings.length,
      openFindings: input.findings.filter((f) => f.status === 'open' || f.status === 'confirmed')
        .length,
      routes: totalRoutes,
      costUsd: totalCost,
      costPerFinding: input.findings.length ? totalCost / input.findings.length : null,
    },
    personas,
    coverage: {
      nodes: [...nodes.values()]
        .map((n) => ({ route: n.route, visits: n.visits, personas: [...n.personas].sort() }))
        .sort((a, b) => b.visits - a.visits),
      edges: [...edges.values()].sort((a, b) => b.count - a.count),
    },
    timeline,
    endpoints,
    heals: {
      pending: input.heals.filter((h) => h.status === 'pending').length,
      approved: decidedHeals.length - rejected,
      rejected,
      /** Share of reviewed heals a human rejected: the heal ladder's false-heal rate. */
      falseHealRate: decidedHeals.length ? rejected / decidedHeals.length : null,
    },
    flaky: input.sessions
      // Only runs that have replays: a score without replays is legacy (pre-replay) data.
      .filter((s) => s.mode === 'explore' && s.flakinessScore > 0 && replayed.has(s.id))
      .map((s) => ({ id: s.id, name: s.name, flakinessScore: s.flakinessScore }))
      .sort((a, b) => b.flakinessScore - a.flakinessScore)
      .slice(0, 10),
  };
}

export type Analytics = ReturnType<typeof computeAnalytics>;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}
