#!/usr/bin/env node
// End-to-end check: starts the mock app, server and runner (from built output), runs the
// agent against the mock app's login goal, and asserts the run is recorded with evidence.
//
//   node scripts/smoke.mjs              one run in demo mode (CI)
//   node scripts/smoke.mjs --runs 5     goal-completion benchmark; prints success rate,
//                                       actions, time and LLM cost per run
//   node scripts/smoke.mjs --live       use the LLM configured in apps/server/.env instead
//                                       of demo mode (costs money, needs a key)
//   --persona <id>                      persona for the benchmark runs (default happy-path)
//
// Prerequisites: `pnpm build`, `pnpm db:setup`, Chromium installed for Playwright.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '1' },
    live: { type: 'boolean', default: false },
    persona: { type: 'string', default: 'happy-path' },
    goal: { type: 'string', default: 'Sign in with valid credentials and reach the dashboard.' },
  },
});
const RUNS = Math.max(1, Number(args.runs) || 1);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'http://localhost:3001';
const TARGET = 'http://localhost:3000';
const PROJECT_ID = 'local-app-test-project-id';

const children = [];

function start(name, cwd, argv, extraEnv = {}) {
  const child = spawn(process.execPath, argv, {
    cwd: path.join(root, cwd),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (line) => `[${name}] ${line}`;
  const pipe = (stream, out) =>
    stream.on('data', (d) =>
      out.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'),
    );
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const getJson = async (url) => (await fetch(url)).json();

async function runOnce(index, { personaId = args.persona, seed, goal = args.goal } = {}) {
  const res = await fetch(`${SERVER}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      targetUrl: TARGET,
      personaId,
      ...(seed === undefined ? {} : { seed }),
      goal,
      budgets: { maxSteps: 15 },
    }),
  });
  if (res.status !== 201)
    throw new Error(`session creation returned ${res.status}: ${await res.text()}`);
  const { id } = await res.json();

  const session = await waitFor(
    `run ${index} to finish`,
    async () => {
      const s = await getJson(`${SERVER}/api/sessions/${id}`);
      return s.status !== 'RUNNING' ? s : null;
    },
    180_000,
  );
  // The trace is uploaded right after the run finishes.
  const withTrace = await waitFor(
    'trace upload',
    async () => {
      const s = await getJson(`${SERVER}/api/sessions/${id}`);
      return s.traceUrl ? s : null;
    },
    30_000,
  ).catch(() => session);

  console.log(`\nRun ${index}: ${session.status} (${session.endReason}) - ${session.summary}`);
  for (const s of session.steps) {
    const issues = s.issuesJson ? ` [${JSON.parse(s.issuesJson).length} issue(s)]` : '';
    const value = s.value ? ` = ${JSON.stringify(s.value)}` : '';
    const behavior = s.behavior ? ` <${s.behavior}>` : '';
    console.log(
      `  ${s.stepNumber}. ${s.action.padEnd(8)} ${s.status.padEnd(7)} ${s.description}${value}${behavior}${issues}`,
    );
  }
  return withTrace;
}

async function main() {
  const llmEnv = args.live ? {} : { GHOSTIQ_LLM_PROVIDER: 'mock' };
  start('mock', 'examples/mock-target-app', ['server.js']);
  start('server', 'apps/server', ['dist/index.js'], llmEnv);
  await waitFor('server health', async () => (await fetch(`${SERVER}/healthz`)).ok);
  await waitFor('mock app', async () => (await fetch(TARGET)).ok);

  start('runner', 'apps/runner', ['dist/index.js', '-k', PROJECT_ID, '-u', SERVER]);
  await waitFor('runner registration', async () => {
    const projects = await getJson(`${SERVER}/api/projects`);
    return projects.some((p) => p.id === PROJECT_ID && p.agentOnline);
  });

  const llm = await waitFor('LLM health check', async () => {
    const status = await getJson(`${SERVER}/api/llm/status`);
    return status.health ? status : null;
  });
  console.log(
    `\nLLM: ${llm.provider}/${llm.model} (${llm.mode}); health: ${llm.health.ok ? 'ok' : llm.health.message}`,
  );

  const results = [];
  for (let i = 1; i <= RUNS; i++) results.push(await runOnce(i));

  if (RUNS > 1 || args.live) {
    const met = results.filter((r) => r.endReason === 'goal_met').length;
    const actions = results.map((r) => r.steps.length - 1);
    const cost = results.reduce((sum, r) => sum + (r.llmUsage?.costUsd ?? 0), 0);
    const seconds = results.map((r) => (new Date(r.endedAt) - new Date(r.startedAt)) / 1000);
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log('\n=== Goal-completion benchmark ===');
    console.log(`model          : ${llm.provider}/${llm.model}`);
    console.log(`goal           : ${args.goal}`);
    console.log(`success rate   : ${met}/${RUNS} (${Math.round((met / RUNS) * 100)}%)`);
    console.log(`median actions : ${median(actions)}`);
    console.log(`median time    : ${median(seconds).toFixed(1)} s`);
    console.log(`total LLM cost : $${cost.toFixed(5)} (mean $${(cost / RUNS).toFixed(5)}/run)`);
    console.log(
      `end reasons    : ${JSON.stringify(Object.fromEntries(Object.entries(Object.groupBy(results, (r) => r.endReason)).map(([k, v]) => [k, v.length])))}`,
    );
  }

  if (!args.live) {
    // Demo mode is deterministic, so CI can assert the exact flow.
    const run = results[0];
    assert(
      run.status === 'PASSED' && run.endReason === 'goal_met',
      `expected goal_met, got ${run.endReason}`,
    );
    const kinds = run.steps.map((s) => s.action);
    assert(
      JSON.stringify(kinds) === JSON.stringify(['GOTO', 'FILL', 'FILL', 'CLICK']),
      `unexpected steps ${kinds}`,
    );
    assert(run.steps[1].value === 'testuser@ghostiq.io', 'email was typed');
    assert(run.steps[2].value === '••••••', 'password value is masked');
    const click = JSON.parse(run.steps[3].locatorJson);
    assert(click.role === 'button' && click.name === 'Sign In', 'durable locator recorded');
    assert(
      run.steps.every((s) => s.screenshotPath),
      'every step has a screenshot',
    );
    assert(run.llmUsage.calls >= 4, 'planner calls were metered');
    assert(run.traceUrl, 'Playwright trace uploaded');
    assert((await fetch(`${SERVER}${run.traceUrl}`)).ok, 'trace is downloadable');
    const project = await getJson(`${SERVER}/api/projects/${PROJECT_ID}`);
    assert(
      project.endpoints.some((e) => e.url.endsWith('/api/auth/login')),
      'login API call recorded',
    );

    // Personas as data: same persona + same seed reproduces the same inputs and behaviors.
    console.log('\n--- Reproducibility: form-stress-tester, seeds 1234, 1234, 99 ---');
    const fingerprint = (r) =>
      JSON.stringify(r.steps.map((s) => [s.action, s.behavior ?? null, s.value ?? null]));
    const goal = 'Stress the login form.';
    const a = await runOnce('seed 1234 (a)', { personaId: 'form-stress-tester', seed: 1234, goal });
    const b = await runOnce('seed 1234 (b)', { personaId: 'form-stress-tester', seed: 1234, goal });
    const c = await runOnce('seed 99', { personaId: 'form-stress-tester', seed: 99, goal });
    assert(a.seed === 1234 && a.persona === 'Form Stress Tester', 'persona and seed recorded');
    assert(a.steps[1].value !== 'testuser@ghostiq.io', 'form stress persona used generated input');
    assert(fingerprint(a) === fingerprint(b), 'same seed reproduced the same inputs and behaviors');
    assert(fingerprint(a) !== fingerprint(c), 'a different seed produced different inputs');
  }

  console.log('\nSmoke test passed.');
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nSmoke test FAILED: ${err.message}`);
  exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await sleep(500);
  process.exit(exitCode);
}
