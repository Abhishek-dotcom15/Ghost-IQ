import { describe, expect, it } from 'vitest';
import { computeAnalytics, type AnalyticsSession } from './compute.js';

const now = new Date('2026-11-02T12:00:00Z');
const session = (
  id: string,
  persona: string,
  urls: string[],
  extra: Partial<AnalyticsSession> = {},
) => ({
  id,
  name: `${persona} run`,
  persona,
  mode: 'explore',
  status: 'PASSED',
  endReason: 'goal_met',
  startedAt: now,
  flakinessScore: 0,
  steps: urls.map((url, i) => ({ stepNumber: i + 1, url })),
  ...extra,
});

const result = computeAnalytics({
  sessions: [
    session('a', 'Happy Path', ['http://x/', 'http://x/', 'http://x/products/1', 'http://x/cart']),
    session('b', 'Form Stress', ['http://x/', 'http://x/login'], {
      endReason: 'stuck',
      status: 'FAILED',
    }),
    session('r', 'Happy Path', ['http://x/', 'http://x/cart'], {
      mode: 'replay',
      status: 'FAILED',
      replayOfId: 'c',
    }),
    session('c', 'Happy Path', ['http://x/'], { flakinessScore: 40 }),
    // A legacy score with no replays behind it is not reported.
    session('d', 'Happy Path', ['http://x/'], { flakinessScore: 50 }),
  ],
  costBySession: new Map([
    ['a', 0.02],
    ['b', 0.01],
  ]),
  findings: [
    { id: 'f1', severity: 'high', status: 'open', firstSeenAt: new Date('2026-11-02T08:00:00Z') },
    {
      id: 'f2',
      severity: 'low',
      status: 'dismissed',
      firstSeenAt: new Date('2026-11-01T08:00:00Z'),
    },
  ],
  occurrences: [
    { findingId: 'f1', sessionId: 'b' },
    { findingId: 'f2', sessionId: 'b' },
    { findingId: 'f1', sessionId: 'a' },
  ],
  requests: [
    ...Array.from({ length: 19 }, () => ({
      method: 'GET',
      url: 'http://x/api/products/1',
      status: 200,
      latencyMs: 100,
    })),
    { method: 'GET', url: 'http://x/api/products/2', status: 200, latencyMs: 2000 },
    { method: 'POST', url: 'http://x/api/orders', status: 500, latencyMs: 50 },
  ],
  heals: [
    { status: 'pending', method: 'llm' },
    { status: 'approved', method: 'fuzzy' },
    { status: 'rejected', method: 'llm' },
  ],
  days: 7,
  now,
});

describe('computeAnalytics', () => {
  it('builds the coverage graph from explore runs only', () => {
    expect(result.coverage.nodes.map((n) => n.route).sort()).toEqual([
      '/',
      '/cart',
      '/login',
      '/products/:id',
    ]);
    expect(result.coverage.edges).toContainEqual({ from: '/', to: '/products/:id', count: 1 });
    expect(result.coverage.edges.find((e) => e.from === '/' && e.to === '/cart')).toBeUndefined(); // replay
    expect(result.coverage.nodes.find((n) => n.route === '/')).toMatchObject({ visits: 4 });
  });

  it('scores personas by coverage, findings and cost', () => {
    const stress = result.personas.find((p) => p.persona === 'Form Stress')!;
    expect(stress).toMatchObject({
      runs: 1,
      goalMet: 0,
      findings: 2,
      routes: 2,
      costPerFinding: 0.005,
    });
    expect(stress.coverage).toBe(0.5);
    expect(result.personas[0]!.persona).toBe('Form Stress'); // most findings first
  });

  it('counts findings per day, endpoint percentiles and heal outcomes', () => {
    expect(result.timeline).toHaveLength(7);
    expect(result.timeline.at(-1)).toMatchObject({ day: '2026-11-02', high: 1 });
    expect(result.timeline.at(-2)).toMatchObject({ day: '2026-11-01', low: 1 });
    const products = result.endpoints.find((e) => e.route === '/api/products/:id')!;
    expect(products).toMatchObject({ calls: 20, p50: 100, p95: 100, errorRate: 0 });
    expect(result.endpoints.find((e) => e.method === 'POST')!.errorRate).toBe(1);
    expect(result.heals).toEqual({ pending: 1, approved: 1, rejected: 1, falseHealRate: 0.5 });
    expect(result.totals).toMatchObject({
      runs: 4,
      replays: 1,
      replayPassRate: 0,
      findings: 2,
      openFindings: 1,
    });
    expect(result.totals.costPerFinding).toBeCloseTo(0.015);
    expect(result.flaky).toEqual([{ id: 'c', name: 'Happy Path run', flakinessScore: 40 }]);
  });
});
