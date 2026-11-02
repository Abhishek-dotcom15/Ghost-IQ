#!/usr/bin/env node
// End-to-end check of a server with sign-in ON: runners need a project API key, the CLI
// authenticates with one, the dashboard asks anonymous visitors to sign in, evidence files
// need access, and a public project is readable (read-only) without signing in.
//
// Prerequisites: `pnpm build` (dashboard included), Chromium installed for Playwright.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER,
  TARGET,
  assert,
  prepareDatabase,
  root,
  sleep,
  start,
  startMockApp,
  startServer,
  stopAll,
  waitFor,
} from './lib/stack.mjs';

const { chromium } = createRequire(path.join(root, 'apps/runner/package.json'))('playwright');
const ADMIN = `e2e-admin-token-${Date.now()}-abcdefghijklmnop`;
const admin = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
const ok = (label) => console.log(`✓ ${label}`);

async function api(method, url, { headers = admin, body } = {}) {
  const res = await fetch(`${SERVER}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  const db = path.join(os.tmpdir(), `ghostiq-auth-e2e-${Date.now()}.db`).replace(/\\/g, '/');
  prepareDatabase(`file:${db}`);
  startMockApp({}, { quiet: true });
  startServer(
    {
      DATABASE_URL: `file:${db}`,
      GHOSTIQ_LLM_PROVIDER: 'mock',
      GHOSTIQ_AUTH: 'on',
      GHOSTIQ_ADMIN_TOKEN: ADMIN,
      GHOSTIQ_DASHBOARD_DIR: path.join(root, 'apps/dashboard/dist'),
    },
    { quiet: true },
  );
  await waitFor('server', async () => (await fetch(`${SERVER}/healthz`)).ok);

  // ---- API: anonymous vs admin, keys
  assert(
    (await api('GET', '/api/projects', { headers: {} })).body.length === 0,
    'anonymous sees no projects',
  );
  assert(
    (await api('POST', '/api/projects', { headers: {}, body: { name: 'x' } })).status === 401,
    'anonymous cannot create',
  );
  const project = (await api('POST', '/api/projects', { body: { name: 'Secured shop' } })).body;
  const key = (
    await api('POST', `/api/projects/${project.id}/keys`, { body: { name: 'e2e runner' } })
  ).body.key;
  assert(key?.startsWith('gq_'), 'API key created');
  ok('admin token creates projects and API keys; anonymous is refused');

  // ---- runner without / with key
  const intruder = start(
    'runner-nokey',
    'apps/runner',
    ['dist/index.js', '-k', project.id, '-u', SERVER],
    { GHOSTIQ_API_KEY: '' },
    { quiet: true },
  );
  await sleep(3000);
  assert(
    !(await api('GET', `/api/projects/${project.id}`)).body.agentOnline,
    'runner without a key is refused',
  );
  intruder.kill();
  start(
    'runner',
    'apps/runner',
    ['dist/index.js', '-k', project.id, '-u', SERVER, '--api-key', key],
    {},
    { quiet: true },
  );
  await waitFor(
    'keyed runner',
    async () => (await api('GET', `/api/projects/${project.id}`)).body.agentOnline,
  );
  ok('runner needs the project key, and connects with it');

  // ---- a run with the key: planner calls and trace upload are authenticated too
  const asKey = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const started = await api('POST', '/api/sessions', {
    headers: asKey,
    body: {
      projectId: project.id,
      targetUrl: TARGET,
      personaId: 'happy-path',
      goal: 'Log in to the shop.',
    },
  });
  assert(started.status === 201, `run started with the key (${started.status})`);
  const run = await waitFor(
    'run',
    async () => {
      const s = (await api('GET', `/api/sessions/${started.body.id}`, { headers: asKey })).body;
      return s.status !== 'RUNNING' && s.traceUrl ? s : null;
    },
    120_000,
  );
  assert(run.endReason === 'goal_met', `run met its goal (${run.endReason}: ${run.summary})`);
  ok('run with key: planner calls, steps and trace upload all authenticated');

  const shot = run.steps.find((s) => s.screenshotPath).screenshotPath;
  assert((await fetch(`${SERVER}${shot}`)).status === 401, 'anonymous cannot fetch evidence');
  assert(
    (await fetch(`${SERVER}${shot}`, { headers: asKey })).status === 200,
    'key can fetch evidence',
  );
  assert(
    (await fetch(`${SERVER}${run.traceUrl}`)).status === 401,
    'anonymous cannot fetch the trace',
  );
  ok('screenshots and traces need project access');

  // ---- CLI against the secured server
  const cli = spawnSync(
    process.execPath,
    [
      path.join(root, 'apps/runner/dist/cli.js'),
      'run',
      '--server',
      SERVER,
      '-t',
      TARGET,
      '-p',
      'happy-path',
      '-g',
      'Log in to the shop.',
      '--fail-on',
      'none',
      '-o',
      path.join(root, 'evals/auth-e2e/cli'),
      '--formats',
      'json',
    ],
    { env: { ...process.env, GHOSTIQ_API_KEY: key }, encoding: 'utf8', timeout: 300_000 },
  );
  if (cli.status !== 0) console.log(cli.stdout, cli.stderr);
  assert(cli.status === 0, `CLI run with GHOSTIQ_API_KEY (exit ${cli.status})`);
  const noKey = spawnSync(
    process.execPath,
    [
      path.join(root, 'apps/runner/dist/cli.js'),
      'run',
      '--server',
      SERVER,
      '-t',
      TARGET,
      '-o',
      path.join(root, 'evals/auth-e2e/nokey'),
    ],
    {
      env: { ...process.env, GHOSTIQ_API_KEY: '' },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert(
    noKey.status === 2 || noKey.status === 3,
    `CLI without a key fails cleanly (exit ${noKey.status})`,
  );
  ok(`CLI authenticates with GHOSTIQ_API_KEY; without it exits ${noKey.status}`);

  // ---- dashboard
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(SERVER);
    await page.getByRole('heading', { name: 'Sign in to GhostIQ' }).waitFor();
    ok('anonymous visitor gets the sign-in screen');
    await page.getByLabel('Administrator token').fill('wrong-token');
    await page.getByRole('button', { name: /Sign in with admin token/ }).click();
    await page.getByRole('alert').waitFor();
    await page.getByLabel('Administrator token').fill(ADMIN);
    await page.getByRole('button', { name: /Sign in with admin token/ }).click();
    await page.getByRole('button', { name: 'Sign out' }).waitFor();
    await page.getByRole('button', { name: /Access & Keys/ }).click();
    await page.getByText('e2e runner', { exact: true }).waitFor();
    await page.getByLabel('Key name').fill('from the dashboard');
    await page.getByRole('button', { name: 'Create key' }).click();
    const shown = await page.locator('code.code-block').first().innerText();
    assert(shown.startsWith('gq_'), 'dashboard shows the new key once');
    await page.getByRole('button', { name: /Make public/ }).click();
    await page.getByText(/Visibility: public/).waitFor();
    ok('admin signs in, creates a key, makes the project public');

    const visitor = await browser.newPage();
    await visitor.goto(SERVER);
    await visitor.locator('main header').getByText('Secured shop').waitFor();
    assert(
      (await visitor.getByRole('button', { name: /New project/i }).count()) === 0,
      'no create button for visitors',
    );
    assert(
      await visitor.getByRole('button', { name: /Sign in/ }).isVisible(),
      'sign-in button offered',
    );
    ok('public project is readable without signing in (read-only)');
    assert(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
  }

  const audit = (await api('GET', `/api/projects/${project.id}/audit`)).body.map((e) => e.action);
  for (const action of ['project.create', 'api_key.create', 'run.start', 'project.update']) {
    assert(audit.includes(action), `audit has ${action}`);
  }
  ok(`audit log recorded: ${[...new Set(audit)].join(', ')}`);
  console.log('\nAuth end-to-end check passed.');
}

let exitCode = 0;
try {
  fs.rmSync(path.join(root, 'evals/auth-e2e'), { recursive: true, force: true });
  await main();
} catch (err) {
  console.error(`\nAuth end-to-end check FAILED: ${err.message}`);
  exitCode = 1;
} finally {
  await stopAll();
  process.exit(exitCode);
}
