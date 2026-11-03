#!/usr/bin/env node
// Benchmark B1 (seeded bugs): run personas against the demo shop and score the findings
// against examples/mock-target-app/bugs.json.
//
//   node scripts/bench-bugs.mjs                  all personas, demo mode (deterministic crawler)
//   node scripts/bench-bugs.mjs --live --max-cost-usd 0.50
//                                                use the LLM configured in apps/server/.env
//   node scripts/bench-bugs.mjs --model gemini:gemini-3.5-flash-lite --max-cost-usd 0.50
//   node scripts/bench-bugs.mjs --personas happy-path,impatient-user --steps 40 --no-visual
//   node scripts/bench-bugs.mjs --runs 3 --seed 7 --json > b1.json
//
// Uses its own throwaway database, so earlier runs never inflate the score. With --runs N each
// persona runs N times and findings are pooled (a bug counts as found if any run found it).
// Writes evals/results/B1-<date>-<model>.json in the common result format (scripts/lib/eval.mjs);
// `node scripts/eval-report.mjs` turns those files into the tables in docs/EVALUATION.md.
// Prerequisites: `pnpm build`, Chromium.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UsageError,
  assertLlmMode,
  buildResult,
  createCostMeter,
  createLog,
  gitSha,
  parseBenchArgs,
  pct,
  serverLlmEnv,
  usd,
  writeResult,
} from './lib/eval.mjs';
import {
  SERVER,
  TARGET,
  getJson,
  postJson,
  prepareDatabase,
  printSession,
  root,
  runSession,
  startMockApp,
  startRunner,
  startServer,
  stop,
  stopAll,
  sleep,
  waitFor,
  waitForRunner,
} from './lib/stack.mjs';

const ALL_PERSONAS = [
  'happy-path',
  'chaotic-explorer',
  'form-stress-tester',
  'impatient-user',
  'keyboard-only',
  'mobile-slow-network',
  'unicode-boundary',
  'security-hygiene',
];

let args;
let common;
try {
  ({ values: args, common } = parseBenchArgs({
    personas: { type: 'string', default: ALL_PERSONAS.join(',') },
    steps: { type: 'string', default: '60' },
    visual: { type: 'boolean', default: true }, // --no-visual
    'show-steps': { type: 'boolean', default: false },
    /** CI guard: exit non-zero when recall of detectable bugs falls below this (0-1). */
    'min-recall': { type: 'string' },
  }));
} catch (err) {
  console.error(err instanceof UsageError ? err.message : String(err));
  process.exit(2);
}
const log = createLog(common);
const personas = args.personas
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const GOAL = 'Explore the whole app: try every page, form and control, and find defects.';

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'examples/mock-target-app/bugs.json'), 'utf8'),
);

function fits(finding, m) {
  return (
    finding.type === m.type &&
    (!m.route || finding.route === m.route) &&
    (!m.rule || finding.rule === m.rule)
  );
}

const matches = (finding, bug) => fits(finding, bug.match);
/** Knock-on findings of a planted bug: not false positives, but not detections either. */
const isConsequence = (finding, bug) => (bug.consequences ?? []).some((m) => fits(finding, m));

async function main() {
  const quiet = !common.verbose;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-bench-'));
  const databaseUrl = `file:${path.join(dir, 'bench.db').replaceAll('\\', '/')}`;
  prepareDatabase(databaseUrl);

  const mock = startMockApp({}, { quiet });
  startServer(
    {
      DATABASE_URL: databaseUrl,
      GHOSTIQ_SCREENSHOT_DIR: path.join(dir, 'screenshots'),
      GHOSTIQ_ARTIFACT_DIR: path.join(dir, 'artifacts'),
      ...serverLlmEnv(common),
    },
    { quiet },
  );
  await waitFor('server', async () => (await fetch(`${SERVER}/healthz`)).ok);
  await waitFor('demo shop', async () => (await fetch(TARGET)).ok);
  const { llm } = await getJson(`${SERVER}/healthz`);
  assertLlmMode(common, llm);
  const meter = createCostMeter({
    server: SERVER,
    maxCostUsd: common.maxCostUsd,
    provider: llm.provider,
  });
  const project = await postJson(`${SERVER}/api/projects`, { name: 'Bug benchmark' });
  startRunner(project.id, { quiet });
  await waitForRunner(project.id);

  log(
    `\nBenchmark B1 (seeded bugs) · ${manifest.bugs.length} bugs · model ${llm.provider}/${llm.model}` +
      (common.maxCostUsd === null ? '' : ` · limit ${usd(common.maxCostUsd)}`),
  );
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const runs = [];
  const run = async (personaId, label, repetition) => {
    await postJson(`${TARGET}/__reset`, {});
    const t0 = Date.now();
    const session = await meter.guard(
      runSession({
        projectId: project.id,
        targetUrl: TARGET,
        personaId,
        goal: GOAL,
        ...(common.seed === null ? {} : { seed: common.seed + repetition }),
        budgets: { maxSteps: Number(args.steps), maxDurationMs: 900_000 },
        allowDestructive: true, // our own throwaway demo app
        consent: true,
      }),
    );
    const found = (await getJson(`${SERVER}/api/sessions/${session.id}/findings`)).summary.total;
    log(
      `  ${label.padEnd(28)} ${String(session.steps.length).padStart(3)} steps  ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s  ${session.endReason.padEnd(14)} ${found} findings`,
    );
    if (args['show-steps']) printSession(label, session);
    runs.push({
      persona: personaId,
      label,
      repetition,
      seed: session.seed ?? null,
      sessionId: session.id,
      steps: session.steps.length,
      endReason: session.endReason,
      findings: found,
      seconds: (Date.now() - t0) / 1000,
      costUsd: session.llmUsage?.costUsd ?? 0,
      tokens: { in: session.llmUsage?.tokensIn ?? 0, out: session.llmUsage?.tokensOut ?? 0 },
    });
    await meter.check();
    return session;
  };

  for (let r = 0; r < common.runs; r++) {
    for (const persona of personas) {
      await run(persona, common.runs > 1 ? `${persona} #${r + 1}` : persona, r);
    }
  }

  if (args.visual && personas.includes('happy-path')) {
    // Visual regression needs a reference: mark the happy-path run as baseline, then
    // restart the shop with the planted visual change and run the same persona again.
    const baseline = runs.find((r) => r.persona === 'happy-path');
    await postJson(`${SERVER}/api/sessions/${baseline.sessionId}/set-baseline`, {});
    await stop(mock);
    await sleep(500);
    startMockApp({ MOCK_VISUAL_REGRESSION: '1' }, { quiet }); // stopped by stopAll()
    await waitFor('demo shop (visual regression)', async () => (await fetch(TARGET)).ok);
    await run('happy-path', 'happy-path (visual v2)', 0);
  }

  const { findings } = await getJson(`${SERVER}/api/projects/${project.id}/findings`);

  // ---- score
  const results = manifest.bugs.map((bug) => {
    const hits = findings.filter((f) => matches(f, bug));
    return {
      id: bug.id,
      category: bug.category,
      title: bug.title,
      detectable: bug.detectable !== false,
      detected: hits.length > 0,
      personas: [...new Set(hits.flatMap((h) => h.personas))],
      findings: hits.map((h) => h.id),
    };
  });
  const matchedIds = new Set(results.flatMap((r) => r.findings));
  const unmatched = findings.filter(
    (f) => !matchedIds.has(f.id) && !manifest.bugs.some((bug) => isConsequence(f, bug)),
  );

  const detected = results.filter((r) => r.detected).length;
  const detectable = results.filter((r) => r.detectable);
  const detectedOfDetectable = detectable.filter((r) => r.detected).length;
  const precision = findings.length ? (findings.length - unmatched.length) / findings.length : 0;

  log('\nBug                          Category        Found  By');
  for (const r of results) {
    const mark = r.detected ? 'yes' : r.detectable ? 'NO ' : 'n/a';
    log(`  ${r.id.padEnd(27)} ${r.category.padEnd(15)} ${mark}    ${r.personas.join(', ')}`);
  }

  const byCategory = {};
  for (const r of results) {
    byCategory[r.category] ??= { bugs: 0, detected: 0 };
    byCategory[r.category].bugs++;
    if (r.detected) byCategory[r.category].detected++;
  }

  const byPersona = {};
  for (const persona of personas) {
    const own = results.filter((r) =>
      r.personas.includes(personaName(findings, persona) ?? persona),
    );
    byPersona[persona] = own.length;
  }

  const usage = await meter.usage();
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  const matched = findings.length - unmatched.length;

  log('\n=== Summary ===');
  log(
    `recall (all bugs)        : ${detected}/${results.length} (${pct(detected, results.length)})`,
  );
  log(
    `recall (detectable bugs) : ${detectedOfDetectable}/${detectable.length} (${pct(detectedOfDetectable, detectable.length)})`,
  );
  log(`findings reported        : ${findings.length}, matched to a planted bug: ${matched}`);
  log(
    `precision (vs manifest)  : ${pct(matched, findings.length)}  (unmatched findings may be real issues the manifest does not list)`,
  );
  log(
    `by category              : ${Object.entries(byCategory)
      .map(([c, v]) => `${c} ${v.detected}/${v.bugs}`)
      .join(', ')}`,
  );
  log(`total time               : ${wallSeconds} s`);
  log(
    `LLM                      : ${usage.calls} calls, ${usage.tokensIn + usage.tokensOut} tokens, ${usd(usage.costUsd)}`,
  );
  if (unmatched.length) {
    log('\nFindings not in the manifest (review: false positive or unlisted bug?):');
    for (const f of unmatched) {
      log(`  [${f.severity}] ${f.type} ${f.route} ${f.rule ?? ''} - ${f.title}`);
      log(
        `      first seen at step ${f.evidence.stepNumber} on ${f.evidence.pageUrl} (${f.personas.join(', ')})`,
      );
    }
  }

  const result = buildResult({
    bench: 'B1',
    llm,
    sha: gitSha(root),
    startedAt,
    finishedAt: new Date().toISOString(),
    params: {
      personas,
      maxSteps: Number(args.steps),
      runs: common.runs,
      seed: common.seed,
      visual: args.visual && personas.includes('happy-path'),
      maxCostUsd: common.maxCostUsd,
    },
    runs,
    summary: {
      bugs: results.length,
      detectableBugs: detectable.length,
      detected,
      detectedOfDetectable,
      recallAll: detected / results.length,
      recallDetectable: detectedOfDetectable / detectable.length,
      findings: findings.length,
      matchedFindings: matched,
      precision,
      byCategory,
      byPersona,
      wallSeconds,
    },
    usage,
    extra: {
      bugs: results,
      unmatchedFindings: unmatched.map((f) => ({
        type: f.type,
        route: f.route,
        rule: f.rule,
        title: f.title,
        severity: f.severity,
        personas: f.personas,
      })),
    },
  });
  const file = writeResult(root, result);
  log(`\nResults written to ${path.relative(root, file)}`);
  if (common.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  const floor = args['min-recall'] === undefined ? null : Number(args['min-recall']);
  const recall = detectedOfDetectable / detectable.length;
  if (floor !== null && recall < floor) {
    throw new Error(
      `Recall ${pct(detectedOfDetectable, detectable.length)} is below the required ${Math.round(floor * 100)}%`,
    );
  }
}

function personaName(findings, personaId) {
  const names = {
    'happy-path': 'Happy Path User',
    'chaotic-explorer': 'Chaotic Explorer',
    'form-stress-tester': 'Form Stress Tester',
    'impatient-user': 'Impatient User',
    'keyboard-only': 'Keyboard-only User',
    'mobile-slow-network': 'Mobile User on Slow 3G',
    'unicode-boundary': 'Unicode & International User',
    'security-hygiene': 'Security Hygiene Prober',
  };
  return names[personaId];
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nBenchmark FAILED: ${err.stack ?? err.message}`);
  exitCode = 1;
} finally {
  await stopAll();
  process.exit(exitCode);
}
