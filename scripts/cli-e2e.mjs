#!/usr/bin/env node
// End-to-end check of the `ghostiq` CLI (built output), in demo mode:
//   1. `ghostiq run` with a throwaway server: reports, GitHub outputs, exit codes 0/1/2/3
//   2. against a long-lived server: run, export, replay, issues --dry-run
//   3. `ghostiq mcp`: an MCP client lists the tools and calls one
//
// Prerequisites: `pnpm build`, Chromium installed for Playwright.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SERVER,
  assert,
  getJson,
  prepareDatabase,
  root,
  startMockApp,
  startServer,
  stopAll,
  waitFor,
} from './lib/stack.mjs';

const CLI = path.join(root, 'apps/runner/dist/cli.js');
const OUT = path.join(root, 'evals/cli-e2e');
const TARGET = 'http://localhost:3000';
const GOAL = 'Log in to the shop.';
const demoEnv = { ...process.env, GHOSTIQ_LLM_PROVIDER: 'mock' };

function ghostiq(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...demoEnv, ...env },
    encoding: 'utf8',
    timeout: 600_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function expectCode(label, result, code) {
  if (result.code !== code) console.log(result.out);
  assert(result.code === code, `${label}: expected exit ${code}, got ${result.code}`);
  console.log(`✓ ${label} (exit ${code})`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  startMockApp({}, { quiet: true });
  await waitFor('mock app', async () => (await fetch(TARGET)).ok);

  // ---- 1. throwaway server
  console.log('--- ghostiq run (temporary local server) ---');
  const ghOut = path.join(OUT, 'github_output.txt');
  const ghSummary = path.join(OUT, 'step_summary.md');
  const failing = ghostiq(
    [
      'run',
      '-t',
      TARGET,
      '-p',
      'happy-path',
      '-g',
      GOAL,
      '--fail-on',
      'critical',
      '-o',
      path.join(OUT, 'a'),
    ],
    { GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: ghSummary },
  );
  expectCode('planted critical a11y bugs fail the gate', failing, 1);
  for (const f of ['report.html', 'junit.xml', 'ghostiq.sarif', 'report.json', 'summary.md']) {
    assert(fs.existsSync(path.join(OUT, 'a', f)), `${f} written`);
  }
  const outputs = fs.readFileSync(ghOut, 'utf8');
  assert(
    /exit-code=1/.test(outputs) && /failing-findings=[1-9]/.test(outputs),
    'GITHUB_OUTPUT written',
  );
  const summary = fs.readFileSync(ghSummary, 'utf8');
  assert(
    summary.startsWith('<!-- ghostiq-report -->') && summary.includes('Happy Path User'),
    'job summary written',
  );
  const sarif = JSON.parse(fs.readFileSync(path.join(OUT, 'a', 'ghostiq.sarif'), 'utf8'));
  assert(sarif.version === '2.1.0' && sarif.runs[0].results.length > 0, 'SARIF has results');

  expectCode(
    '--fail-on none passes',
    ghostiq([
      'run',
      '-t',
      TARGET,
      '-p',
      'happy-path',
      '-g',
      GOAL,
      '--fail-on',
      'none',
      '-o',
      path.join(OUT, 'b'),
      '--formats',
      'json',
    ]),
    0,
  );
  expectCode('bad flag is a usage error', ghostiq(['run', '-t', TARGET, '--fail-on', 'severe']), 2);
  expectCode('missing target is a usage error', ghostiq(['run'], { GHOSTIQ_TARGET: '' }), 2);
  expectCode(
    'unreachable server is an infrastructure error',
    ghostiq(['run', '-t', TARGET, '--server', 'http://127.0.0.1:9', '-o', path.join(OUT, 'c')]),
    3,
  );

  // ---- 2. long-lived server
  console.log('\n--- long-lived server: run, export, replay, issues ---');
  const db = path.join(os.tmpdir(), `ghostiq-cli-e2e-${Date.now()}.db`).replace(/\\/g, '/');
  prepareDatabase(`file:${db}`);
  startServer({ DATABASE_URL: `file:${db}`, GHOSTIQ_LLM_PROVIDER: 'mock' }, { quiet: true });
  await waitFor('server', async () => (await fetch(`${SERVER}/healthz`)).ok);
  expectCode(
    'run against --server',
    ghostiq([
      'run',
      '--server',
      SERVER,
      '--project',
      'cli-e2e',
      '-t',
      TARGET,
      '-p',
      'happy-path',
      '-g',
      GOAL,
      '--fail-on',
      'none',
      '-o',
      path.join(OUT, 'd'),
    ]),
    0,
  );
  const project = (await getJson(`${SERVER}/api/projects`)).find((p) => p.name === 'cli-e2e');
  assert(project, 'project created by name');
  const sessionId = (await getJson(`${SERVER}/api/projects/${project.id}`)).sessions[0].id;

  const specFile = path.join(OUT, 'login.spec.ts');
  expectCode('export', ghostiq(['export', sessionId, '-o', specFile, '--server', SERVER]), 0);
  assert(fs.readFileSync(specFile, 'utf8').includes("from '@playwright/test'"), 'spec written');

  const replay = ghostiq(['replay', sessionId, '-n', '2', '--server', SERVER]);
  expectCode('replay x2', replay, 0);
  assert(/2 passed, 0 failed · flakiness 0%/.test(replay.out), 'replay stats printed');

  const issues = ghostiq([
    'issues',
    '--dry-run',
    '--repo',
    'example/shop',
    '--project',
    'cli-e2e',
    '--min-severity',
    'critical',
    '--server',
    SERVER,
  ]);
  expectCode('issues --dry-run', issues, 0);
  assert(/\+ would file: \[GhostIQ\]/.test(issues.out), 'issues planned');

  // ---- 3. MCP
  console.log('\n--- ghostiq mcp ---');
  const sdk = (p) =>
    pathToFileURL(path.join(root, 'apps/runner/node_modules/@modelcontextprotocol/sdk/dist/esm', p))
      .href;
  const { Client } = await import(sdk('client/index.js'));
  const { StdioClientTransport } = await import(sdk('client/stdio.js'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp', '--server', SERVER, '--project', 'cli-e2e'],
    env: { ...demoEnv },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'cli-e2e', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify([
        'ghostiq_export_test',
        'ghostiq_get_run',
        'ghostiq_list_findings',
        'ghostiq_list_personas',
        'ghostiq_replay',
        'ghostiq_run',
      ]),
    `MCP tools: ${names}`,
  );
  const personas = await client.callTool({ name: 'ghostiq_list_personas', arguments: {} });
  assert(personas.content[0].text.includes('happy-path'), 'MCP tool call returns personas');
  const findings = await client.callTool({
    name: 'ghostiq_list_findings',
    arguments: { minSeverity: 'critical' },
  });
  assert(JSON.parse(findings.content[0].text).length > 0, 'MCP lists findings');
  await client.close();
  console.log(`✓ MCP server: ${names.length} tools, calls work`);

  console.log('\nCLI end-to-end check passed.');
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nCLI end-to-end check FAILED: ${err.message}`);
  exitCode = 1;
} finally {
  await stopAll();
  process.exit(exitCode);
}
