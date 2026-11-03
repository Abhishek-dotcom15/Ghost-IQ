// Shared plumbing for the benchmark scripts (scripts/bench-*.mjs):
//   - common command-line options (--live, --model, --runs, --seed, --max-cost-usd, --json)
//   - the cost guard (a live benchmark refuses to start without a spending limit and stops
//     when the limit is reached, using the server's own LLM metering)
//   - the common result format written to evals/results/<bench>-<date>-<model>.json
//   - small Markdown helpers shared with scripts/eval-report.mjs
// Pure functions are exported separately so scripts/lib/eval.test.mjs can test them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

/** Version of the result file layout. Bump when a field changes meaning. */
export const RESULT_FORMAT = 1;

const PROVIDERS = ['gemini', 'claude', 'openai', 'ollama', 'mock'];
/** Providers that cost nothing to call; the cost guard does not need prices for them. */
const FREE_PROVIDERS = new Set(['ollama', 'mock']);

/** Options every benchmark accepts. Benchmarks add their own on top. */
export const COMMON_OPTIONS = {
  /** Use a real model instead of demo mode (the scripted planner). */
  live: { type: 'boolean', default: false },
  /** provider:model, e.g. gemini:gemini-3.5-flash-lite. Implies --live unless provider is mock. */
  model: { type: 'string' },
  /** Repetitions per task or persona. */
  runs: { type: 'string', default: '1' },
  /** Base seed for persona input generation (each run derives its own from it). */
  seed: { type: 'string' },
  /** Stop the benchmark once the measured LLM spend exceeds this many US dollars. */
  'max-cost-usd': { type: 'string' },
  /** Print only the result JSON on stdout (progress goes to stderr). */
  json: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
};

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Parses "provider:model" (the model part may itself contain colons, e.g. ollama tags). */
export function parseModelSpec(value) {
  if (!value) return null;
  const [provider, ...rest] = value.split(':');
  if (!PROVIDERS.includes(provider)) {
    throw new UsageError(
      `--model: unknown provider "${provider}". Use one of: ${PROVIDERS.join(', ')}`,
    );
  }
  const model = rest.join(':').trim();
  return model ? { provider, model } : { provider };
}

/**
 * Validates and normalises the common options. Throws UsageError with a fix when the
 * combination is unsafe, most importantly a live run without a spending limit.
 */
export function resolveCommon(values) {
  const model = parseModelSpec(values.model);
  const live = values.live || (model !== null && model.provider !== 'mock');
  const runs = Number(values.runs ?? 1);
  if (!Number.isInteger(runs) || runs < 1)
    throw new UsageError('--runs must be a whole number of at least 1');
  const seed = values.seed === undefined ? null : Number(values.seed);
  if (seed !== null && !Number.isInteger(seed))
    throw new UsageError('--seed must be a whole number');

  let maxCostUsd = null;
  if (values['max-cost-usd'] !== undefined) {
    maxCostUsd = Number(values['max-cost-usd']);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
      throw new UsageError('--max-cost-usd must be a positive number of US dollars, e.g. 0.50');
    }
  }
  const free = model !== null && FREE_PROVIDERS.has(model.provider);
  if (live && maxCostUsd === null && !free) {
    throw new UsageError(
      'A live benchmark calls a paid model. Set a spending limit, e.g. --max-cost-usd 0.50 ' +
        '(the run stops when the measured spend passes it).',
    );
  }
  return {
    live,
    model,
    runs,
    seed,
    maxCostUsd,
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
  };
}

/** parseArgs with the common options merged in. Returns { values, common }. */
export function parseBenchArgs(extraOptions = {}, argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowNegative: true,
    options: { ...COMMON_OPTIONS, ...extraOptions },
  });
  return { values, common: resolveCommon(values) };
}

/**
 * Environment for the GhostIQ server under test. Demo mode forces the mock provider;
 * live mode disables fallbacks, so a failing model can never be silently replaced by the
 * scripted planner and inflate the numbers.
 */
export function serverLlmEnv(common) {
  if (!common.live) return { GHOSTIQ_LLM_PROVIDER: 'mock', GHOSTIQ_LLM_FALLBACK: '' };
  const env = { GHOSTIQ_LLM_FALLBACK: '', GHOSTIQ_LLM_RECORD_MODE: 'off' };
  if (common.model) {
    env.GHOSTIQ_LLM_PROVIDER = common.model.provider;
    if (common.model.model) env.GHOSTIQ_LLM_MODEL = common.model.model;
  }
  return env;
}

/** Fails fast when --live was asked for but the server fell back to demo mode (e.g. no key). */
export function assertLlmMode(common, llm) {
  if (common.live && (llm.mode === 'demo' || llm.provider === 'mock')) {
    throw new UsageError(
      `--live was requested but the server is in demo mode${llm.demoReason ? ` (${llm.demoReason})` : ''}. ` +
        'Put the API key in apps/server/.env (e.g. GEMINI_API_KEY=...) or pass --model provider:model.',
    );
  }
  if (!common.live && llm.provider !== 'mock') {
    throw new UsageError(`Demo mode expected the mock provider, got ${llm.provider}.`);
  }
}

export class BudgetExceededError extends Error {
  constructor(spentUsd, limitUsd) {
    super(
      `LLM spend $${spentUsd.toFixed(4)} passed the limit of $${limitUsd.toFixed(2)}; benchmark stopped.`,
    );
    this.name = 'BudgetExceededError';
    this.spentUsd = spentUsd;
  }
}

/**
 * Decides whether the benchmark may continue given the server's usage numbers
 * (GET /api/llm/status → usage.allTime; the benchmark uses a throwaway database, so
 * "all time" means "this benchmark"). Returns null to continue or an Error to stop.
 */
export function budgetVerdict(usage, { maxCostUsd, provider }) {
  if (maxCostUsd === null) return null;
  if (usage.unpricedCalls > 0 && !FREE_PROVIDERS.has(provider)) {
    return new UsageError(
      `${usage.unpricedCalls} LLM call(s) had no known price, so the spending limit cannot be enforced. ` +
        'Set GHOSTIQ_LLM_PRICE_INPUT and GHOSTIQ_LLM_PRICE_OUTPUT (USD per million tokens) in apps/server/.env.',
    );
  }
  if (usage.costUsd > maxCostUsd) return new BudgetExceededError(usage.costUsd, maxCostUsd);
  return null;
}

/**
 * Watches the server's LLM spend while a benchmark runs. `guard(promise)` resolves with the
 * promise or rejects as soon as the spend passes the limit (checked every `intervalMs`).
 */
export function createCostMeter({
  server,
  maxCostUsd,
  provider,
  intervalMs = 2000,
  fetchImpl = fetch,
}) {
  const read = async () =>
    (await (await fetchImpl(`${server}/api/llm/status`)).json()).usage.allTime;
  const check = async () => {
    const usage = await read();
    const err = budgetVerdict(usage, { maxCostUsd, provider });
    if (err) throw err;
    return usage;
  };
  return {
    usage: read,
    check,
    async guard(promise) {
      if (maxCostUsd === null) return promise;
      let timer;
      const watchdog = new Promise((_, reject) => {
        timer = setInterval(() => check().catch(reject), intervalMs);
      });
      try {
        return await Promise.race([promise, watchdog]);
      } finally {
        clearInterval(timer);
      }
    },
  };
}

export function gitSha(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/** File-name-safe slug for a model label like "gemini/gemini-3.5-flash-lite". */
export function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Builds a result object in the common format. `runs` and `summary` are benchmark-specific. */
export function buildResult({
  bench,
  llm,
  sha,
  startedAt,
  finishedAt,
  params,
  runs,
  summary,
  usage,
  extra = {},
}) {
  return {
    format: RESULT_FORMAT,
    bench,
    model: llm.model,
    provider: llm.provider,
    mode: llm.provider === 'mock' ? 'demo' : 'live',
    gitSha: sha,
    startedAt,
    finishedAt,
    params,
    runs,
    summary,
    costUsd: usage.costUsd,
    tokens: { in: usage.tokensIn, out: usage.tokensOut },
    llmCalls: { total: usage.calls, failed: usage.failedCalls, unpriced: usage.unpricedCalls },
    ...extra,
  };
}

export function resultFileName(result) {
  const date = result.startedAt.replace(/[:.]/g, '-');
  return `${result.bench}-${date}-${slug(`${result.provider}-${result.model}`)}.json`;
}

/** Writes the result under <root>/evals/results and returns the file path. */
export function writeResult(root, result) {
  const dir = path.join(root, 'evals', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, resultFileName(result));
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/** Reads every common-format result file in a directory (older ad-hoc files are skipped). */
export function readResults(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return data.format === RESULT_FORMAT && data.bench ? [{ ...data, file: f }] : [];
      } catch {
        return [];
      }
    });
}

// ---------- Markdown helpers ----------

export const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
export const usd = (n) =>
  n === null || n === undefined ? 'n/a' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** Renders a Markdown table with columns padded so Prettier leaves it unchanged. */
export function markdownTable(headers, rows) {
  const cells = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(3, ...cells.map((r) => r[i].length)));
  const line = (r) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [
    line(cells[0]),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...cells.slice(1).map(line),
  ].join('\n');
}

/**
 * Replaces the text between `<!-- eval:NAME:start -->` and `<!-- eval:NAME:end -->`.
 * Throws when the markers are missing so a renamed section is noticed.
 */
export function replaceSection(doc, name, body) {
  const start = `<!-- eval:${name}:start -->`;
  const end = `<!-- eval:${name}:end -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  if (i === -1 || j === -1 || j < i) throw new Error(`Markers for section "${name}" not found`);
  return `${doc.slice(0, i + start.length)}\n\n${body.trim()}\n\n${doc.slice(j)}`;
}

// ---------- report rendering (used by scripts/eval-report.mjs) ----------

/** Keeps the newest result per configuration key. */
export function latestBy(results, keyOf) {
  const latest = new Map();
  for (const r of results) {
    const key = keyOf(r);
    const prev = latest.get(key);
    if (!prev || r.startedAt > prev.startedAt) latest.set(key, r);
  }
  return [...latest.values()];
}

export const modelLabel = (r) =>
  r.provider === 'mock' ? 'demo (scripted planner)' : `${r.provider}/${r.model}`;

const ALL_B1_PERSONAS = 8;
const personaLabel = (personas) =>
  personas.length >= ALL_B1_PERSONAS ? `all ${personas.length}` : personas.join(', ');
const minutes = (s) => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

function renderB1(results) {
  const rows = latestBy(
    results,
    (r) =>
      `${r.provider}|${r.model}|${[...r.params.personas].sort().join(',')}|${r.params.visual}|${r.params.maxSteps}|${r.params.runs}`,
  ).sort(
    (a, b) =>
      b.params.personas.length - a.params.personas.length || a.startedAt.localeCompare(b.startedAt),
  );
  if (!rows.length) return {};
  const s = (r) => r.summary;
  const summary = markdownTable(
    [
      'Planner',
      'Personas',
      'Steps',
      'Runs',
      'Recall, all bugs',
      'Recall, detectable',
      'Precision',
      'LLM cost',
      'Time',
      'Date',
      'Commit',
    ],
    rows.map((r) => [
      modelLabel(r),
      personaLabel(r.params.personas) + (r.params.visual ? ' + visual' : ''),
      r.params.maxSteps,
      r.params.runs,
      `${s(r).detected} / ${s(r).bugs} (${pct(s(r).detected, s(r).bugs)})`,
      `${s(r).detectedOfDetectable} / ${s(r).detectableBugs} (${pct(s(r).detectedOfDetectable, s(r).detectableBugs)})`,
      `${s(r).matchedFindings} / ${s(r).findings} (${pct(s(r).matchedFindings, s(r).findings)})`,
      r.mode === 'demo' ? 'none' : usd(r.costUsd),
      minutes(s(r).wallSeconds),
      r.startedAt.slice(0, 10),
      r.gitSha ? `\`${r.gitSha}\`` : '',
    ]),
  );
  const categories = [...new Set(rows.flatMap((r) => Object.keys(s(r).byCategory)))];
  const header = rows.map((r, i) => (rows.length === 1 ? 'Found' : `#${i + 1}`));
  const byCategory = markdownTable(
    ['Category', ...header],
    categories.map((c) => [
      c,
      ...rows.map((r) => {
        const v = s(r).byCategory[c];
        return v ? `${v.detected} / ${v.bugs}` : '';
      }),
    ]),
  );
  const note =
    rows.length > 1 ? `\n\nColumns #1-#${rows.length} follow the rows of the table above.` : '';
  return { B1: summary, 'B1-categories': byCategory + note };
}

const RENDERERS = { B1: renderB1 };

/** Turns result files into { sectionName: markdown }. Benchmarks without files are omitted. */
export function renderSections(results) {
  const sections = {};
  for (const [bench, render] of Object.entries(RENDERERS)) {
    const own = results.filter((r) => r.bench === bench);
    if (own.length) Object.assign(sections, render(own));
  }
  return sections;
}

/** A logger that keeps stdout clean for --json. */
export function createLog(common) {
  const out = common.json ? process.stderr : process.stdout;
  return (...parts) => out.write(`${parts.join(' ')}\n`);
}
