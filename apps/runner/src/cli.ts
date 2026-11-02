#!/usr/bin/env node
// `ghostiq`: run personas against an app in CI, replay and export recorded runs, file
// findings as GitHub issues, serve GhostIQ to coding agents over MCP, or run a runner agent.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { SEVERITIES, type Severity } from '@ghostiq/shared';
import { startAgent } from './agent.js';
import { ApiError, GhostiqClient, UnreachableError } from './cli/client.js';
import {
  ConfigError,
  FAIL_ON,
  REPORT_FORMATS,
  findConfigFile,
  loadConfigFile,
  resolveConfig,
} from './cli/config.js';
import { EXIT } from './cli/gate.js';
import { createIssue, existingMarkers, issueTitle, planIssues } from './cli/issues.js';
import { runCommand } from './cli/run.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('ghostiq')
  .description('GhostIQ: persona-driven exploratory testing for web apps')
  .version(VERSION)
  .showHelpAfterError()
  .addHelpText(
    'after',
    `
Exit codes: 0 pass · 1 findings/replay/goal gate failed · 2 usage or config error · 3 GhostIQ could not run
Docs: https://github.com/Abhishek-dotcom15/Ghost-IQ#ci`,
  );

const int = (name: string) => (value: string) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0)
    throw new InvalidArgumentError(`${name} must be a whole number`);
  return n;
};
const csv = (value: string) =>
  value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
const serverUrl = (value?: string) => value ?? process.env.GHOSTIQ_SERVER_URL;

// ------------------------------------------------------------------ run
program
  .command('run')
  .description('Explore the target with each persona, write reports, and fail on findings')
  .option('-c, --config <file>', 'config file (default: ghostiq.config.{ts,mts,mjs,js,json})')
  .option('-t, --target <url>', 'app under test')
  .option('-p, --personas <ids>', 'comma-separated persona ids', csv)
  .option('-g, --goal <text>', 'goal for every persona')
  .option('--seed <n>', 'seed for inputs, pacing and behaviors', int('seed'))
  .option('--max-steps <n>', 'actions per persona', int('max-steps'))
  .option('--fail-on <severity>', `${FAIL_ON.join(' | ')} (default high)`)
  .option('--new-only', 'only count findings first seen in these runs')
  .option('--include-suspected', 'count heuristic findings towards --fail-on')
  .option('--fail-on-goal', 'fail when a persona does not reach the goal')
  .option('-s, --server <url>', 'GhostIQ server (default: start a temporary local one)')
  .option('--project <name>', 'project name or id on the server')
  .option('--no-agent', 'use a runner that is already connected instead of an embedded one')
  .option('-o, --report-dir <dir>', 'where to write reports (default ghostiq-report)')
  .option('--formats <list>', `report formats: ${REPORT_FORMATS.join(',')}`, csv)
  .option('--consent', 'confirm you may test the target (needed by the security persona)')
  .option('--storage-state <file>', 'Playwright storageState JSON to start logged in')
  .option('--headed', 'show the browser')
  .action(async (opts) => {
    let config;
    try {
      const file = findConfigFile(process.cwd(), opts.config);
      const fromFile = file ? await loadConfigFile(file) : {};
      if (opts.failOn && !(FAIL_ON as readonly string[]).includes(opts.failOn)) {
        throw new ConfigError(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
      }
      config = resolveConfig(fromFile, {
        target: opts.target ?? process.env.GHOSTIQ_TARGET,
        personas: opts.personas,
        goal: opts.goal,
        seed: opts.seed,
        budgets: opts.maxSteps ? { maxSteps: opts.maxSteps } : undefined,
        failOn: opts.failOn,
        newOnly: opts.newOnly,
        includeSuspected: opts.includeSuspected,
        failOnGoal: opts.failOnGoal,
        server: serverUrl(opts.server),
        project: opts.project,
        reports:
          opts.reportDir || opts.formats
            ? { dir: opts.reportDir, formats: opts.formats }
            : undefined,
        consent: opts.consent,
        storageState: opts.storageState,
        headed: opts.headed,
      });
      if (file) console.log(`Config: ${path.relative(process.cwd(), file)}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(EXIT.usage);
    }
    const result = await runCommand(config, { embeddedAgent: opts.agent !== false });
    process.exit(result.exitCode);
  });

// ------------------------------------------------------------------ replay
program
  .command('replay <sessionId>')
  .description('Replay a recorded run (no planner model); fails if any replay diverges')
  .option('-n, --runs <n>', 'number of replays (1-10)', int('runs'), 1)
  .option('-s, --server <url>', 'GhostIQ server (required: replays need the recording)')
  .option('--no-agent', 'use a runner that is already connected')
  .option('--headed', 'show the browser')
  .action(async (sessionId: string, opts) => {
    await withServer(opts.server, async (client) => {
      const source = await client.session(sessionId);
      const agent =
        opts.agent !== false
          ? startAgent(
              source.projectId,
              {
                serverUrl: client.baseUrl,
                headless: !opts.headed,
                trace: true,
                apiKey: client.apiKey,
                log: () => {},
              },
              () => {},
            )
          : undefined;
      try {
        if (agent) await agent.connected;
        await waitOnline(client, source.projectId);
        const { sessions } = await client.replay(sessionId, opts.runs);
        let failed = 0;
        for (const s of sessions) {
          const r = await client.waitForSession(s.id);
          const healed = r.steps.filter((st) => st.healed).map((st) => st.stepNumber);
          console.log(
            `${r.status === 'PASSED' ? '✓' : '✗'} ${r.name}: ${r.endReason} - ${r.summary ?? ''}${healed.length ? ` (healed step ${healed.join(', ')}; review in the dashboard)` : ''}`,
          );
          if (r.status !== 'PASSED') failed++;
        }
        const stats = await client.replays(sessionId);
        console.log(
          `Replays: ${stats.passed} passed, ${stats.failed} failed · flakiness ${Math.round(stats.flakinessScore)}%`,
        );
        return failed ? EXIT.gate : EXIT.ok;
      } finally {
        await agent?.stop();
      }
    });
  });

// ------------------------------------------------------------------ export
program
  .command('export <sessionId>')
  .description('Write a recorded run as a self-contained Playwright test')
  .option('-o, --out <file>', 'output file (default: print to stdout)')
  .option('-s, --server <url>', 'GhostIQ server')
  .action(async (sessionId: string, opts) => {
    await withServer(opts.server, async (client) => {
      const result = await client.exportSpec(sessionId);
      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(opts.out, result.code);
        console.error(`Wrote ${opts.out}`);
      } else {
        process.stdout.write(result.code);
      }
      if (result.skipped)
        console.error(`${result.skipped} step(s) could not be exported (see comments).`);
      if (result.secrets.length) console.error(`Set before running: ${result.secrets.join(', ')}`);
      return EXIT.ok;
    });
  });

// ------------------------------------------------------------------ issues
program
  .command('issues')
  .description('Open GitHub issues for findings (idempotent: never files the same finding twice)')
  .requiredOption('--repo <owner/name>', 'GitHub repository', process.env.GITHUB_REPOSITORY)
  .option('--project <name>', 'project name or id', 'ghostiq-ci')
  .option('--sessions <ids>', 'only findings from these runs', csv)
  .option('--min-severity <severity>', `${SEVERITIES.join(' | ')}`, 'high')
  .option('--include-suspected', 'also file heuristic findings')
  .option('--dry-run', 'print what would be filed without creating issues')
  .option('-s, --server <url>', 'GhostIQ server')
  .action(async (opts) => {
    if (!(SEVERITIES as readonly string[]).includes(opts.minSeverity)) {
      console.error(`--min-severity must be one of ${SEVERITIES.join(', ')}`);
      process.exit(EXIT.usage);
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token && !opts.dryRun) {
      console.error('Set GITHUB_TOKEN (issues: write) or use --dry-run.');
      process.exit(EXIT.usage);
    }
    await withServer(opts.server, async (client) => {
      const project = await client.resolveProject(opts.project, false);
      const { findings } = await client.findings(project.id, {
        sessions: opts.sessions,
        status: 'open,confirmed',
      });
      const target = { repo: opts.repo as string, token: token ?? '' };
      const existing = token ? await existingMarkers(target) : new Map<string, number>();
      const plan = planIssues(
        findings,
        existing,
        opts.minSeverity as Severity,
        !!opts.includeSuspected,
      );
      for (const { finding, issue } of plan.existing)
        console.log(`= #${issue} already tracks: ${finding.title}`);
      for (const finding of plan.create) {
        if (opts.dryRun) {
          console.log(`+ would file: ${issueTitle(finding)}`);
        } else {
          console.log(`+ #${await createIssue(target, finding)} ${issueTitle(finding)}`);
        }
      }
      console.log(`${plan.create.length} new, ${plan.existing.length} already filed.`);
      return EXIT.ok;
    });
  });

// ------------------------------------------------------------------ mcp
program
  .command('mcp')
  .description('Serve GhostIQ to coding agents over MCP (stdio)')
  .option('-s, --server <url>', 'GhostIQ server (default: start a temporary local one)')
  .option('--project <name>', 'default project name or id', 'ghostiq-mcp')
  .option('--headed', 'show the browser')
  .action(async (opts) => {
    const { startMcpServer } = await import('./cli/mcp.js');
    await startMcpServer({
      server: serverUrl(opts.server),
      project: opts.project,
      headed: !!opts.headed,
    });
  });

// ------------------------------------------------------------------ agent
program
  .command('agent')
  .description('Run a long-lived runner agent for a project (same as ghostiq-agent)')
  .requiredOption('-k, --key <projectId>', 'project id', process.env.GHOSTIQ_PROJECT_ID)
  .option(
    '-u, --url <url>',
    'GhostIQ server',
    process.env.GHOSTIQ_SERVER_URL ?? 'http://localhost:3001',
  )
  .option(
    '--api-key <key>',
    'project API key (servers with sign-in on)',
    process.env.GHOSTIQ_API_KEY,
  )
  .option('--headed', 'show the browser')
  .option('--no-trace', 'do not record Playwright traces')
  .option(
    '--storage-state <file>',
    'Playwright storageState JSON',
    process.env.GHOSTIQ_STORAGE_STATE,
  )
  .action((opts) => {
    const agent = startAgent(opts.key, {
      serverUrl: opts.url.replace(/\/+$/, ''),
      headless: !opts.headed,
      trace: opts.trace,
      storageStatePath: opts.storageState,
      apiKey: opts.apiKey,
    });
    const exit = () => void agent.stop().then(() => process.exit(0));
    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
  });

// ------------------------------------------------------------------ init
program
  .command('init')
  .description('Write a starter ghostiq.config.mjs')
  .option('-t, --target <url>', 'app under test', 'http://localhost:3000')
  .action((opts) => {
    const file = path.resolve('ghostiq.config.mjs');
    if (fs.existsSync(file)) {
      console.error(`${file} already exists.`);
      process.exit(EXIT.usage);
    }
    fs.writeFileSync(file, starterConfig(opts.target));
    console.log(`Wrote ${file}. Try: ghostiq run`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(EXIT.infra);
});

/** Runs fn against the given (or GHOSTIQ_SERVER_URL) server and exits with its code. */
async function withServer(url: string | undefined, fn: (client: GhostiqClient) => Promise<number>) {
  const base = serverUrl(url);
  if (!base) {
    console.error(
      'This command needs a GhostIQ server that has the recording: pass --server <url> or set GHOSTIQ_SERVER_URL.',
    );
    process.exit(EXIT.usage);
  }
  try {
    process.exit(await fn(new GhostiqClient(base)));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    if (err instanceof UnreachableError) process.exit(EXIT.infra);
    if (err instanceof ApiError && err.status < 500 && err.status !== 409) process.exit(EXIT.usage);
    process.exit(EXIT.infra);
  }
}

async function waitOnline(client: GhostiqClient, projectId: string) {
  const deadline = Date.now() + 15_000;
  while (!(await client.project(projectId)).agentOnline) {
    if (Date.now() > deadline) throw new UnreachableError('No runner is online for this project.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

function starterConfig(target: string): string {
  return `// GhostIQ configuration. Every field can be overridden with a CLI flag (ghostiq run --help).
export default {
  target: process.env.GHOSTIQ_TARGET ?? ${JSON.stringify(target)},
  personas: ['happy-path', 'form-stress-tester'],
  // goal: 'Sign up, add a product to the cart and check out.',
  budgets: { maxSteps: 40 },
  // Fail the build on findings at or above this severity: critical | high | medium | low | info | none
  failOn: 'high',
  // Only fail on findings that are new in this run (with a long-lived server).
  newOnly: false,
  reports: { dir: 'ghostiq-report', formats: ['html', 'junit', 'sarif', 'json'] },
};
`;
}
