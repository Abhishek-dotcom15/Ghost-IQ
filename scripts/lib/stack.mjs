// Shared helpers for scripts that run the whole stack (smoke test, benchmarks):
// start the demo app, server and runner from built output, start runs, wait for them.
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Ports can be moved so a check can run next to a local dev instance on 3000/3001:
//   GHOSTIQ_STACK_SERVER_PORT=4001 GHOSTIQ_STACK_TARGET_PORT=4000 node scripts/bench-bugs.mjs
const SERVER_PORT = Number(process.env.GHOSTIQ_STACK_SERVER_PORT) || 3001;
const TARGET_PORT = Number(process.env.GHOSTIQ_STACK_TARGET_PORT) || 3000;
export const SERVER = `http://localhost:${SERVER_PORT}`;
export const TARGET = `http://localhost:${TARGET_PORT}`;

const children = new Set();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function start(name, cwd, argv, extraEnv = {}, { quiet = false } = {}) {
  const child = spawn(process.execPath, argv, {
    cwd: path.join(root, cwd),
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (line) => `[${name}] ${line}`;
  const pipe = (stream, out) =>
    stream.on('data', (d) => {
      if (quiet) return;
      out.write(d.toString().split('\n').filter(Boolean).map(prefix).join('\n') + '\n');
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

export async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, sleep(3000)]);
}

export async function stopAll() {
  await Promise.all([...children].map(stop));
}

export async function waitFor(label, check, timeoutMs = 30_000) {
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

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export const getJson = async (url) => (await fetch(url)).json();

export async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Creates a fresh SQLite database with the current schema (for isolated benchmark runs). */
export function prepareDatabase(databaseUrl) {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push'], {
    cwd: path.join(root, 'apps/server'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

export function startMockApp(env = {}, options = {}) {
  return start(
    'mock',
    'examples/mock-target-app',
    ['server.js'],
    { PORT: String(TARGET_PORT), ...env },
    options,
  );
}

export function startServer(env = {}, options = {}) {
  return start(
    'server',
    'apps/server',
    ['dist/index.js'],
    { PORT: String(SERVER_PORT), ...env },
    options,
  );
}

export function startRunner(projectId, options = {}) {
  return start(
    'runner',
    'apps/runner',
    ['dist/index.js', '-k', projectId, '-u', SERVER],
    {},
    options,
  );
}

export async function waitForRunner(projectId) {
  await waitFor('runner registration', async () => {
    const projects = await getJson(`${SERVER}/api/projects`);
    return projects.some((p) => p.id === projectId && p.agentOnline);
  });
}

/** Starts a run and waits for it to finish and upload its trace. Returns the session. */
export async function runSession(body, { timeoutMs = 600_000 } = {}) {
  const { id } = await postJson(`${SERVER}/api/sessions`, body);
  const session = await waitFor(
    `run ${id} to finish`,
    async () => {
      const s = await getJson(`${SERVER}/api/sessions/${id}`);
      return s.status !== 'RUNNING' ? s : null;
    },
    timeoutMs,
  );
  // The trace is uploaded right after the run finishes.
  return waitFor(
    'trace upload',
    async () => {
      const s = await getJson(`${SERVER}/api/sessions/${id}`);
      return s.traceUrl ? s : null;
    },
    30_000,
  ).catch(() => session);
}

export function printSession(label, session) {
  console.log(`\nRun ${label}: ${session.status} (${session.endReason}) - ${session.summary}`);
  for (const s of session.steps) {
    const issues = s.issuesJson ? ` [${JSON.parse(s.issuesJson).length} issue(s)]` : '';
    const value = s.value ? ` = ${JSON.stringify(s.value)}` : '';
    const behavior = s.behavior ? ` <${s.behavior}>` : '';
    console.log(
      `  ${s.stepNumber}. ${s.action.padEnd(8)} ${s.status.padEnd(7)} ${s.description}${value}${behavior}${issues}`,
    );
  }
}
