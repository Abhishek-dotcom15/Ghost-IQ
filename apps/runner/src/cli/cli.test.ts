import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Finding, Session } from './client.js';
import { ConfigError, findConfigFile, loadConfigFile, resolveConfig } from './config.js';
import { EXIT, SUMMARY_MARKER, evaluateGate, renderSummary, type GateOptions } from './gate.js';
import { issueBody, markerFor, planIssues } from './issues.js';

const run = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  name: 'Happy Path: Log in',
  projectId: 'p',
  persona: 'Happy Path User',
  personaId: 'happy-path',
  mode: 'explore',
  status: 'PASSED',
  endReason: 'goal_met',
  summary: 'ok',
  goal: 'Log in',
  seed: 1,
  targetUrl: 'http://app.test',
  traceUrl: null,
  flakinessScore: 0,
  startedAt: '',
  endedAt: '',
  steps: [{ stepNumber: 1, action: 'GOTO', status: 'PASSED', description: 'Open' }],
  llmUsage: { calls: 3, costUsd: 0.0021, tokensIn: 1, tokensOut: 1 },
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  type: 'network_error',
  severity: 'high',
  title: 'POST /api/login returns 500',
  route: '/api/login',
  rule: '500',
  message: 'Internal error',
  confidence: 'confirmed',
  status: 'open',
  recurrences: 1,
  personas: ['Happy Path User'],
  repro: ['Open /', 'Click "Sign In"'],
  evidence: { request: { method: 'POST', url: 'http://app.test/api/login', status: 500 } },
  fingerprint: 'network_error|/api/login|500',
  firstSessionId: 's1',
  ...over,
});

const gateOpts = (over: Partial<GateOptions> = {}): GateOptions => ({
  failOn: 'high',
  newOnly: false,
  includeSuspected: false,
  failOnGoal: false,
  ...over,
});

describe('config', () => {
  it('merges file config and flags, validates and fills defaults', () => {
    const c = resolveConfig(
      { target: 'http://app.test', personas: ['a'], budgets: { maxSteps: 10 }, failOn: 'medium' },
      { personas: ['b', 'c'], budgets: { maxTokens: 5000 }, failOn: undefined },
    );
    expect(c.personas).toEqual(['b', 'c']);
    expect(c.budgets).toEqual({ maxSteps: 10, maxTokens: 5000 });
    expect(c.failOn).toBe('medium');
    expect(c.reports).toEqual({
      dir: 'ghostiq-report',
      formats: ['html', 'junit', 'sarif', 'json'],
    });
    expect(c.project).toBe('ghostiq-ci');
  });

  it('reports readable errors', () => {
    expect(() => resolveConfig({}, {})).toThrow(ConfigError);
    expect(() => resolveConfig({ target: 'not a url' }, {})).toThrow(/target/);
    expect(() => resolveConfig({ target: 'http://x', failOn: 'severe' }, {})).toThrow(/failOn/);
  });

  it('finds and loads JS and JSON config files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-cfg-'));
    expect(findConfigFile(dir)).toBeUndefined();
    fs.writeFileSync(
      path.join(dir, 'ghostiq.config.mjs'),
      "export default { target: 'http://a.test', personas: ['x'] };",
    );
    const file = findConfigFile(dir)!;
    expect(file.endsWith('ghostiq.config.mjs')).toBe(true);
    expect(await loadConfigFile(file)).toEqual({ target: 'http://a.test', personas: ['x'] });
    fs.writeFileSync(path.join(dir, 'other.json'), '{"target":"http://b.test"}');
    expect(await loadConfigFile(findConfigFile(dir, 'other.json')!)).toEqual({
      target: 'http://b.test',
    });
    expect(() => findConfigFile(dir, 'missing.json')).toThrow(ConfigError);
  });
});

describe('evaluateGate', () => {
  it('passes when nothing reaches the threshold', () => {
    const r = evaluateGate([run()], [finding({ severity: 'medium' })], gateOpts());
    expect(r).toMatchObject({ exitCode: EXIT.ok, failing: [] });
  });

  it('fails on findings at or above failOn, ignoring suspected ones unless asked', () => {
    expect(evaluateGate([run()], [finding()], gateOpts()).exitCode).toBe(EXIT.gate);
    expect(
      evaluateGate([run()], [finding({ severity: 'critical' })], gateOpts()).failing,
    ).toHaveLength(1);
    const suspected = finding({ confidence: 'suspected' });
    expect(evaluateGate([run()], [suspected], gateOpts()).exitCode).toBe(EXIT.ok);
    expect(evaluateGate([run()], [suspected], gateOpts({ includeSuspected: true })).exitCode).toBe(
      EXIT.gate,
    );
    expect(evaluateGate([run()], [finding()], gateOpts({ failOn: 'none' })).exitCode).toBe(EXIT.ok);
  });

  it('with newOnly counts only findings first seen in these runs', () => {
    const old = finding({ firstSessionId: 'earlier' });
    expect(evaluateGate([run()], [old], gateOpts({ newOnly: true })).exitCode).toBe(EXIT.ok);
    expect(evaluateGate([run()], [finding()], gateOpts({ newOnly: true })).exitCode).toBe(
      EXIT.gate,
    );
  });

  it('reports infrastructure failures as exit 3, before anything else', () => {
    const r = evaluateGate(
      [run({ endReason: 'planner_error', status: 'FAILED' })],
      [finding()],
      gateOpts(),
    );
    expect(r.exitCode).toBe(EXIT.infra);
  });

  it('fails on diverged replays and, optionally, missed goals', () => {
    expect(
      evaluateGate([run({ mode: 'replay', endReason: 'replay_diverged' })], [], gateOpts())
        .exitCode,
    ).toBe(EXIT.gate);
    const missed = run({ endReason: 'budget_steps', status: 'FAILED' });
    expect(evaluateGate([missed], [], gateOpts()).exitCode).toBe(EXIT.ok);
    expect(evaluateGate([missed], [], gateOpts({ failOnGoal: true })).reasons[0]).toContain(
      'did not reach the goal',
    );
  });
});

describe('renderSummary', () => {
  it('renders a PR comment with the marker, runs, findings and gate', () => {
    const gate = evaluateGate(
      [run()],
      [finding(), finding({ id: 'f2', severity: 'low', title: 'Missing | pipe' })],
      gateOpts(),
    );
    const md = renderSummary({
      target: 'http://app.test',
      runs: [run()],
      findings: [finding(), finding({ id: 'f2', severity: 'low', title: 'Missing | pipe' })],
      gate,
      options: gateOpts(),
      llm: { mode: 'demo', provider: 'mock', model: 'demo' },
      ciRunUrl: 'https://github.com/o/r/actions/runs/1',
      version: '0.8.0',
    });
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(md).toContain('❌ Failed: 1 finding(s) at or above "high"');
    expect(md).toContain('**demo mode**');
    expect(md).toContain('| Happy Path User | ✅ passed | `goal_met` | 0 | $0.0021 |');
    expect(md).toContain('🟠 1 high · 🔵 1 low');
    expect(md).toContain('Missing \\| pipe');
    expect(md).toContain('[CI run and report artifacts](https://github.com/o/r/actions/runs/1)');
    expect(md).toContain('exit 1');
  });
});

describe('GitHub issues', () => {
  it('derives a stable marker from the fingerprint', () => {
    expect(markerFor(finding())).toBe(markerFor(finding({ id: 'other-db-id', title: 'renamed' })));
    expect(markerFor(finding())).not.toBe(markerFor(finding({ fingerprint: 'x|y|z' })));
    expect(markerFor(finding())).toMatch(/^<!-- ghostiq:[0-9a-f]{16} -->$/);
  });

  it('plans only new findings at or above the severity', () => {
    const tracked = finding();
    const fresh = finding({ id: 'f2', fingerprint: 'a|b|c', title: 'XSS', severity: 'critical' });
    const minor = finding({ id: 'f3', fingerprint: 'l|o|w', severity: 'low' });
    const plan = planIssues(
      [tracked, fresh, minor],
      new Map([[markerFor(tracked), 12]]),
      'high',
      false,
    );
    expect(plan.create.map((f) => f.title)).toEqual(['XSS']);
    expect(plan.existing).toEqual([{ finding: tracked, issue: 12 }]);
  });

  it('writes an issue body with evidence, repro steps and the marker', () => {
    const body = issueBody(finding());
    expect(body).toContain('**Request:** `POST http://app.test/api/login` → 500');
    expect(body).toContain('1. Open /');
    expect(body.endsWith(markerFor(finding()))).toBe(true);
  });
});
