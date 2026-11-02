#!/usr/bin/env node
/* global document -- page.evaluate callbacks run in the browser */
// UI check: seeds a fresh database with real runs (explore, replays, a healed replay), then
// drives every dashboard page in a browser and fails on console errors, page errors,
// failed requests, broken links or images. Also launches a run from the dashboard form.
//
// Prerequisites: `pnpm build` (dashboard included), Chromium installed for Playwright.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SERVER,
  TARGET,
  assert,
  getJson,
  postJson,
  prepareDatabase,
  root,
  runSession,
  startMockApp,
  startRunner,
  startServer,
  stopAll,
  waitFor,
  waitForRunner,
} from './lib/stack.mjs';

const { chromium } = createRequire(path.join(root, 'apps/runner/package.json'))('playwright');
const OUT = path.join(root, 'evals/dashboard-check');
const problems = [];
let stopping = false;
let browser;
const note = (p) => {
  problems.push(p);
  console.log(`  ✗ ${p}`);
};

async function waitReplays(sessions) {
  const done = [];
  for (const s of sessions) {
    done.push(
      await waitFor(
        `replay ${s.id}`,
        async () => {
          const x = await getJson(`${SERVER}/api/sessions/${s.id}`);
          return ['PENDING', 'RUNNING'].includes(x.status) ? null : x;
        },
        120_000,
      ),
    );
  }
  return done;
}

async function seed() {
  const project = await postJson(`${SERVER}/api/projects`, { name: 'Dashboard check' });
  startRunner(project.id, { quiet: true });
  await waitForRunner(project.id);
  const base = { projectId: project.id, targetUrl: TARGET };
  const login = await runSession({ ...base, personaId: 'happy-path', goal: 'Log in to the shop.' });
  assert(login.endReason === 'goal_met', 'seed login run');
  await runSession({
    ...base,
    personaId: 'form-stress-tester',
    goal: 'Explore the shop and stress its forms.',
    budgets: { maxSteps: 25 },
  });
  await runSession({
    ...base,
    personaId: 'mobile-slow-network',
    goal: 'Explore the shop.',
    budgets: { maxSteps: 12 },
  });
  await postJson(`${SERVER}/api/sessions/${login.id}/set-baseline`, {});
  const { sessions } = await postJson(`${SERVER}/api/sessions/${login.id}/replay`, { runs: 2 });
  await waitReplays(sessions);
  await postJson(`${TARGET}/__ui`, { loginLabel: 'Sign in now' });
  const healed = await postJson(`${SERVER}/api/sessions/${login.id}/replay`, { runs: 1 });
  await waitReplays(healed.sessions);
  await postJson(`${TARGET}/__ui`, { loginLabel: '' });
  return { project, login };
}

async function checkLinks(page, label) {
  const refs = await page.evaluate(() => [
    ...[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    ...[...document.querySelectorAll('img[src]')].map((i) => i.getAttribute('src')),
  ]);
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((i) => i.complete && i.naturalWidth === 0)
      .map((i) => i.src),
  );
  for (const src of broken) note(`${label}: image does not load: ${src}`);
  let checked = 0;
  for (const ref of new Set(refs)) {
    if (!ref || ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('javascript:'))
      continue;
    const url = new URL(ref, page.url()).toString();
    if (!url.startsWith(SERVER)) continue; // external links are checked by check-links.mjs
    const res = await fetch(url);
    checked++;
    if (res.status >= 400) note(`${label}: link ${ref} -> HTTP ${res.status}`);
  }
  return checked;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const db = path.join(os.tmpdir(), `ghostiq-ui-check-${Date.now()}.db`).replace(/\\/g, '/');
  prepareDatabase(`file:${db}`);
  startMockApp({}, { quiet: true });
  const server = startServer(
    {
      DATABASE_URL: `file:${db}`,
      GHOSTIQ_LLM_PROVIDER: 'mock',
      GHOSTIQ_DASHBOARD_DIR: path.join(root, 'apps/dashboard/dist'),
      GHOSTIQ_SCREENSHOT_DIR: path.join(OUT, 'data/screenshots'),
      GHOSTIQ_ARTIFACT_DIR: path.join(OUT, 'data/artifacts'),
    },
    { quiet: !process.env.GHOSTIQ_DEBUG },
  );
  server.on('exit', (code, signal) => {
    if (!stopping) note(`the server exited unexpectedly (code ${code}, signal ${signal})`);
  });
  await waitFor('server', async () => (await fetch(`${SERVER}/healthz`)).ok);
  await waitFor('mock app', async () => (await fetch(TARGET)).ok);

  console.log('Seeding runs (explore x3, replay x2, healed replay)...');
  const { project, login } = await seed();

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('console', (m) => {
    if (m.type() === 'error') note(`console error on ${page.url()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => note(`page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) note(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(err)) {
      note(`request failed ${r.url()}: ${err}`);
      if (process.env.GHOSTIQ_DEBUG) {
        fetch(`${SERVER}/healthz`).then(
          (h) => console.log(`    (server /healthz from node at that moment: ${h.status})`),
          (e) => console.log(`    (server /healthz from node at that moment: ${e.message})`),
        );
      }
    }
  });

  await page.goto(SERVER);
  await page.getByRole('button', { name: 'Overview' }).waitFor();
  // Select the seeded project.
  await page.locator('select').first().selectOption(project.id);
  await page.waitForTimeout(800);

  const views = [
    'Overview',
    'Test Sessions',
    'Findings',
    'Analytics',
    'Heal Review',
    'API Health',
    'Personas Builder',
    'Settings',
  ];
  let links = 0;
  for (const view of views) {
    console.log(`- ${view}`);
    await page.getByRole('button', { name: view, exact: true }).click();
    // The dashboard holds a Socket.IO long-poll open, so the network never goes idle.
    await page.waitForTimeout(1200);
    const text = await page.locator('main').innerText();
    // Rendering glitches, not app error messages shown as findings ("properties of undefined
    // (reading ...)") or quoted input values ("NaN").
    const bad = text.match(
      /.{0,80}(\[object Object\]|(?<!["'])\bNaN\b(?!["'])|\bundefined\b(?! \(reading)).{0,80}/,
    );
    if (bad) note(`${view}: suspicious text: "${bad[0].replace(/\s+/g, ' ')}"`);
    // SVG presentation attributes cannot resolve CSS variables: such marks render black.
    const varPaint = await page.locator('svg [fill*="var("], svg [stroke*="var("]').count();
    if (varPaint) note(`${view}: ${varPaint} SVG element(s) painted with CSS var() (render black)`);
    if (view === 'API Health' && (await page.locator('.recharts-bar-rectangle').count()) === 0) {
      note('API Health: latency chart has no bars');
    }
    links += await checkLinks(page, view);
    await page.screenshot({
      path: path.join(OUT, `${view.replace(/\s+/g, '-').toLowerCase()}.png`),
      fullPage: true,
    });

    if (view === 'Test Sessions') {
      // Open several runs (explore, replay, healed replay) and every tab.
      const runs = (await getJson(`${SERVER}/api/projects/${project.id}`)).sessions.slice(0, 6);
      for (const run of runs) {
        await page.getByText(run.name, { exact: true }).first().click();
        await page.waitForTimeout(700);
        for (const tab of ['Visual Regression', 'Accessibility Audits', 'Step Trace']) {
          const t = page.getByText(new RegExp(`^${tab}`)).first();
          if (await t.count()) {
            await t.click();
            await page.waitForTimeout(300);
          }
        }
        // Expand the first step.
        const step = page.getByText(/^STEP\s*1$/).first();
        if (await step.count()) await step.click();
        links += await checkLinks(page, `Session ${run.name}`);
      }
      // Downloads offered on the recorded run.
      for (const url of [
        `/api/sessions/${login.id}/export/spec`,
        `/api/sessions/${login.id}/report?format=html`,
        `/api/sessions/${login.id}/report?format=junit`,
        `/api/sessions/${login.id}/report?format=sarif`,
      ]) {
        const res = await fetch(`${SERVER}${url}`);
        if (!res.ok) note(`download ${url} -> ${res.status}`);
      }
    }
    if (view === 'Findings') {
      const first = page
        .locator('main button, main [role=button]')
        .filter({ hasText: /on \// })
        .first();
      if (await first.count()) {
        await first.click();
        await page.waitForTimeout(500);
        links += await checkLinks(page, 'Findings (expanded)');
      }
      for (const f of ['html', 'json', 'junit', 'sarif']) {
        const res = await fetch(`${SERVER}/api/projects/${project.id}/report?format=${f}`);
        if (!res.ok) note(`project report ${f} -> ${res.status}`);
      }
    }
    if (view === 'Analytics') {
      for (const r of ['Last 7 days', 'Last 90 days', 'Last 30 days']) {
        await page.getByRole('button', { name: r }).click();
        await page.waitForTimeout(400);
      }
      const bars = await page.locator('.recharts-bar-rectangle').count();
      if (bars === 0) note('Analytics: no chart bars rendered');
    }
    if (view === 'Heal Review') {
      const approve = page.getByRole('button', { name: 'Approve' }).first();
      assert(await approve.count(), 'a pending heal is listed');
      await approve.click();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.waitForTimeout(800);
      links += await checkLinks(page, 'Heal Review (all)');
    }
  }

  // Launch a run from the dashboard form and watch it finish.
  console.log('- Launch a run from Overview');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByPlaceholder('http://localhost:3000').fill(TARGET);
  await page.getByPlaceholder(/Instruct the AI agent/).fill('Log in to the shop.');
  const before = (await getJson(`${SERVER}/api/projects/${project.id}`)).sessions.length;
  await page.getByRole('button', { name: /Execute Test Session/ }).click();
  const launched = await waitFor(
    'dashboard-launched run',
    async () => {
      const s = (await getJson(`${SERVER}/api/projects/${project.id}`)).sessions;
      return s.length > before && s[0].status !== 'RUNNING' ? s[0] : null;
    },
    120_000,
  );
  if (launched.status !== 'PASSED')
    note(`dashboard-launched run ended ${launched.status} (${launched.endReason})`);
  else
    console.log(`  ✓ run launched from the dashboard: ${launched.status} (${launched.endReason})`);

  await browser.close();
  console.log(
    `\nChecked ${views.length} pages, ${links} same-origin links/images; screenshots in ${path.relative(root, OUT)}`,
  );
  if (problems.length) throw new Error(`${problems.length} problem(s) found`);
  console.log('Dashboard check passed: no console errors, failed requests or broken links.');
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`\nDashboard check FAILED: ${err.message}`);
  exitCode = 1;
} finally {
  stopping = true;
  await browser?.close().catch(() => {});
  await stopAll();
  process.exit(exitCode);
}
