#!/usr/bin/env node
// End-to-end smoke test: starts the mock app, server and runner (from built output),
// triggers one exploration session through the REST API and asserts it is recorded.
// Prerequisites: `pnpm build`, `pnpm db:setup`, Chromium installed for Playwright.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'http://localhost:3001';
const TARGET = 'http://localhost:3000';
const PROJECT_ID = 'local-app-test-project-id';

const children = [];

function start(name, cwd, args) {
  const child = spawn(process.execPath, args, {
    cwd: path.join(root, cwd),
    env: { ...process.env, GHOSTIQ_LLM_PROVIDER: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (line) => `[${name}] ${line}`;
  child.stdout.on('data', (d) =>
    process.stdout.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'),
  );
  child.stderr.on('data', (d) =>
    process.stderr.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n'),
  );
  children.push(child);
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
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

async function main() {
  start('mock', 'examples/mock-target-app', ['server.js']);
  start('server', 'apps/server', ['dist/index.js']);
  await waitFor('server health', async () => (await fetch(`${SERVER}/healthz`)).ok);
  await waitFor('mock app', async () => (await fetch(TARGET)).ok);

  start('runner', 'apps/runner', ['dist/index.js', '-k', PROJECT_ID, '-u', SERVER]);
  await waitFor('runner registration', async () => {
    const projects = await (await fetch(`${SERVER}/api/projects`)).json();
    return projects.some((p) => p.id === PROJECT_ID && p.agentOnline);
  });

  const res = await fetch(`${SERVER}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      targetUrl: TARGET,
      persona: 'Happy Path User',
      goal: 'Log in with valid credentials',
    }),
  });
  assert(res.status === 201, `session creation returned ${res.status}`);
  const { id } = await res.json();

  let session;
  await waitFor(
    'session completion',
    async () => {
      session = await (await fetch(`${SERVER}/api/sessions/${id}`)).json();
      return session.status !== 'RUNNING';
    },
    90_000,
  );

  console.log(`\nSession ${id}: ${session.status}, ${session.steps.length} steps`);
  for (const s of session.steps) console.log(`  ${s.stepNumber}. [${s.status}] ${s.description}`);

  assert(session.status === 'PASSED', `expected PASSED, got ${session.status}`);
  assert(session.steps.length >= 4, 'expected navigation + email + password + submit steps');
  assert(
    session.steps.some((s) => s.action === 'TYPE' && s.value === 'testuser@ghostiq.io'),
    'the email field was filled',
  );
  assert(session.llmUsage?.calls >= 4, 'planner LLM calls were recorded for the run');
  const shot = session.steps[0].screenshotPath;
  assert(shot, 'first step has a screenshot');
  assert((await fetch(`${SERVER}${shot}`)).ok, 'screenshot is served');

  const project = await (await fetch(`${SERVER}/api/projects/${PROJECT_ID}`)).json();
  assert(project.endpoints.length > 0, 'endpoint telemetry recorded');

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
