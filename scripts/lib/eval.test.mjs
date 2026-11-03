// Tests for the benchmark plumbing. Run with: node --test scripts/lib/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  BudgetExceededError,
  RESULT_FORMAT,
  UsageError,
  assertLlmMode,
  budgetVerdict,
  buildResult,
  createCostMeter,
  latestBy,
  markdownTable,
  parseBenchArgs,
  parseModelSpec,
  readResults,
  renderSections,
  replaceSection,
  resultFileName,
  serverLlmEnv,
  writeResult,
} from './eval.mjs';

const usage = (over = {}) => ({
  calls: 10,
  failedCalls: 0,
  fallbackCalls: 0,
  cacheHits: 0,
  unpricedCalls: 0,
  tokensIn: 1000,
  tokensOut: 200,
  costUsd: 0.01,
  latencyMs: 5000,
  ...over,
});

describe('options and the cost guard', () => {
  it('parses provider:model, keeping colons in the model name', () => {
    assert.deepEqual(parseModelSpec('ollama:qwen3:8b'), { provider: 'ollama', model: 'qwen3:8b' });
    assert.deepEqual(parseModelSpec('claude'), { provider: 'claude' });
    assert.equal(parseModelSpec(undefined), null);
    assert.throws(() => parseModelSpec('gpt:4o'), UsageError);
  });

  it('defaults to demo mode', () => {
    const { common } = parseBenchArgs({}, []);
    assert.equal(common.live, false);
    assert.equal(common.runs, 1);
    assert.equal(common.maxCostUsd, null);
    assert.deepEqual(serverLlmEnv(common), {
      GHOSTIQ_LLM_PROVIDER: 'mock',
      GHOSTIQ_LLM_FALLBACK: '',
    });
  });

  it('refuses a paid live run without a spending limit', () => {
    assert.throws(() => parseBenchArgs({}, ['--live']), /--max-cost-usd/);
    assert.throws(
      () => parseBenchArgs({}, ['--model', 'gemini:gemini-3.5-flash-lite']),
      /--max-cost-usd/,
    );
    assert.throws(() => parseBenchArgs({}, ['--live', '--max-cost-usd', '0']), UsageError);
  });

  it('allows free local models without a limit and implies --live from --model', () => {
    const { common } = parseBenchArgs({}, ['--model', 'ollama:llama3.2']);
    assert.equal(common.live, true);
    assert.deepEqual(serverLlmEnv(common), {
      GHOSTIQ_LLM_FALLBACK: '',
      GHOSTIQ_LLM_RECORD_MODE: 'off',
      GHOSTIQ_LLM_PROVIDER: 'ollama',
      GHOSTIQ_LLM_MODEL: 'llama3.2',
    });
  });

  it('validates runs and seed', () => {
    assert.throws(() => parseBenchArgs({}, ['--runs', '0']), /--runs/);
    assert.throws(() => parseBenchArgs({}, ['--seed', '1.5']), /--seed/);
    assert.equal(parseBenchArgs({}, ['--runs', '3', '--seed', '7']).common.seed, 7);
  });

  it('rejects a live benchmark that fell back to demo mode', () => {
    const { common } = parseBenchArgs({}, ['--live', '--max-cost-usd', '1']);
    assert.throws(
      () => assertLlmMode(common, { mode: 'demo', provider: 'mock', demoReason: 'no API key' }),
      /no API key/,
    );
    assert.doesNotThrow(() => assertLlmMode(common, { mode: 'live', provider: 'gemini' }));
  });

  it('stops when spend passes the limit or cannot be measured', () => {
    const opts = { maxCostUsd: 0.5, provider: 'gemini' };
    assert.equal(budgetVerdict(usage({ costUsd: 0.49 }), opts), null);
    assert.ok(budgetVerdict(usage({ costUsd: 0.51 }), opts) instanceof BudgetExceededError);
    assert.match(budgetVerdict(usage({ unpricedCalls: 2 }), opts).message, /PRICE_INPUT/);
    assert.equal(budgetVerdict(usage({ unpricedCalls: 2 }), { ...opts, provider: 'ollama' }), null);
    assert.equal(
      budgetVerdict(usage({ costUsd: 99 }), { maxCostUsd: null, provider: 'gemini' }),
      null,
    );
  });

  it('guard() aborts a long-running promise once the limit is passed', async () => {
    let cost = 0;
    const fetchImpl = async () => ({
      json: async () => ({ usage: { allTime: usage({ costUsd: (cost += 0.3) }) } }),
    });
    const meter = createCostMeter({
      server: 'http://x',
      maxCostUsd: 0.5,
      provider: 'gemini',
      intervalMs: 5,
      fetchImpl,
    });
    const never = new Promise(() => {});
    await assert.rejects(meter.guard(never), BudgetExceededError);
  });
});

describe('result files', () => {
  const llm = { provider: 'mock', model: 'demo' };
  const make = (over = {}) =>
    buildResult({
      bench: 'B1',
      llm,
      sha: 'abc1234',
      startedAt: '2026-11-03T10:00:00.000Z',
      finishedAt: '2026-11-03T10:05:00.000Z',
      params: { personas: ['happy-path'], maxSteps: 80, runs: 1, seed: null, visual: false },
      runs: [],
      summary: {
        bugs: 33,
        detectableBugs: 31,
        detected: 20,
        detectedOfDetectable: 20,
        recallAll: 20 / 33,
        recallDetectable: 20 / 31,
        findings: 28,
        matchedFindings: 28,
        precision: 1,
        byCategory: { accessibility: { bugs: 5, detected: 5 }, auth: { bugs: 2, detected: 0 } },
        byPersona: {},
        wallSeconds: 75,
      },
      usage: usage({ costUsd: 0 }),
      ...over,
    });

  it('builds the common format and a descriptive file name', () => {
    const r = make();
    assert.equal(r.format, RESULT_FORMAT);
    assert.equal(r.mode, 'demo');
    assert.deepEqual(r.tokens, { in: 1000, out: 200 });
    assert.equal(resultFileName(r), 'B1-2026-11-03T10-00-00-000Z-mock-demo.json');
  });

  it('writes and reads back results, skipping older ad-hoc files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-eval-test-'));
    writeResult(dir, make());
    fs.writeFileSync(
      path.join(dir, 'evals', 'results', 'bugs-old.json'),
      '{"benchmark":"B1-seeded-bugs"}',
    );
    fs.writeFileSync(path.join(dir, 'evals', 'results', 'broken.json'), '{');
    const read = readResults(path.join(dir, 'evals', 'results'));
    assert.equal(read.length, 1);
    assert.equal(read[0].bench, 'B1');
  });

  it('keeps the newest result per configuration', () => {
    const a = make();
    const b = make({ startedAt: '2026-11-04T10:00:00.000Z' });
    const c = make({
      params: { personas: ['impatient-user'], maxSteps: 80, runs: 1, visual: false },
    });
    const key = (r) => r.params.personas.join();
    assert.deepEqual(
      latestBy([a, b, c], key).map((r) => r.startedAt + key(r)),
      ['2026-11-04T10:00:00.000Zhappy-path', '2026-11-03T10:00:00.000Zimpatient-user'],
    );
  });

  it('renders B1 tables', () => {
    const sections = renderSections([make()]);
    assert.deepEqual(Object.keys(sections), ['B1', 'B1-categories']);
    assert.match(sections.B1, /demo \(scripted planner\) \| happy-path/);
    assert.match(sections.B1, /20 \/ 31 \(65%\)/);
    assert.match(sections.B1, /28 \/ 28 \(100%\)/);
    assert.match(sections['B1-categories'], /\| auth +\| 0 \/ 2 \|/);
    assert.deepEqual(renderSections([]), {});
  });
});

describe('markdown helpers', () => {
  it('pads tables so every row lines up', () => {
    const t = markdownTable(['A', 'Long header'], [['x', 1]]);
    const lines = t.split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.length === lines[0].length));
  });

  it('replaces only the marked section and fails loudly without markers', () => {
    const doc = 'a\n<!-- eval:B1:start -->\nold\n<!-- eval:B1:end -->\nb\n';
    assert.equal(
      replaceSection(doc, 'B1', 'new'),
      'a\n<!-- eval:B1:start -->\n\nnew\n\n<!-- eval:B1:end -->\nb\n',
    );
    assert.throws(() => replaceSection(doc, 'B2', 'x'), /B2/);
  });
});
