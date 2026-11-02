import fs from 'node:fs';
import path from 'node:path';
import { explainEndReason } from '@ghostiq/shared';
import { startAgent, type AgentHandle } from '../agent.js';
import { VERSION } from '../version.js';
import { ApiError, GhostiqClient, UnreachableError, type Session } from './client.js';
import type { GhostiqConfig } from './config.js';
import { EXIT, evaluateGate, renderSummary, type GateOptions } from './gate.js';
import { startLocalServer, type LocalServer } from './local-server.js';

const REPORT_FILES = {
  html: 'report.html',
  junit: 'junit.xml',
  sarif: 'ghostiq.sarif',
  json: 'report.json',
} as const;

export interface RunCommandOptions {
  /** Start an in-process runner for the project (default). False = use an external runner. */
  embeddedAgent: boolean;
  log?: (msg: string) => void;
}

export interface RunCommandResult {
  exitCode: number;
  runs: Session[];
  summaryFile?: string;
}

/**
 * `ghostiq run`: explore the target with each persona, collect the findings of these runs,
 * write reports and a Markdown summary, and decide the exit code.
 */
export async function runCommand(
  config: GhostiqConfig,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  let local: LocalServer | undefined;
  let agent: AgentHandle | undefined;
  const runs: Session[] = [];

  try {
    if (!config.server) local = await startLocalServer({ log });
    const client = new GhostiqClient(config.server ?? local!.url);
    const health = await client.health();
    log(
      `GhostIQ ${VERSION} · server ${client.baseUrl} · LLM ${health.llm.mode === 'demo' ? 'DEMO MODE (scripted, no AI)' : `${health.llm.provider}/${health.llm.model}`}`,
    );

    const project = await client.resolveProject(config.project);
    if (options.embeddedAgent) {
      agent = startAgent(
        project.id,
        {
          serverUrl: client.baseUrl,
          headless: !config.headed,
          trace: true,
          storageStatePath: config.storageState,
          apiKey: client.apiKey,
          log: process.env.GHOSTIQ_DEBUG ? log : () => {},
        },
        () => {},
      );
      await withTimeout(agent.connected, 15_000, 'runner connection');
      await waitForAgent(client, project.id);
    } else if (!(await client.project(project.id)).agentOnline) {
      throw new UnreachableError(
        `No runner is online for project "${project.name}" (${project.id}). Start one with: ghostiq agent -k ${project.id} -u ${client.baseUrl}`,
      );
    }

    for (const persona of config.personas) {
      log(`\n▶ ${persona} → ${config.target}`);
      const started = await client.startSession({
        projectId: project.id,
        targetUrl: config.target,
        personaId: persona,
        goal: config.goal,
        seed: config.seed,
        budgets: config.budgets,
        allowedOrigins: config.allowedOrigins,
        allowDestructive: config.allowDestructive,
        consent: config.consent,
      });
      const finished = await client.waitForSession(started.id, {
        onProgress: (s) => {
          const last = s.steps.at(-1);
          if (last)
            log(`  ${last.stepNumber}. ${last.status.padEnd(7)} ${last.description.slice(0, 110)}`);
        },
      });
      runs.push(finished);
      log(`  ⇒ ${finished.status} (${finished.endReason}) ${finished.summary ?? ''}`);
      if (finished.status !== 'PASSED') {
        const why = explainEndReason(finished.endReason, {
          summary: finished.summary,
          maxSteps: config.budgets?.maxSteps,
        });
        if (why) {
          log(`    ${why.title}: ${why.detail}`);
          if (why.fix) log(`    What to do: ${why.fix}`);
        }
      }
    }

    const ids = runs.map((r) => r.id);
    const { findings } = await client.findings(project.id, {
      sessions: ids,
      status: 'open,confirmed',
    });
    const gateOptions: GateOptions = {
      failOn: config.failOn,
      newOnly: config.newOnly,
      includeSuspected: config.includeSuspected,
      failOnGoal: config.failOnGoal,
    };
    const gate = evaluateGate(runs, findings, gateOptions);

    // Reports + summary
    const dir = path.resolve(config.reports.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (const format of config.reports.formats) {
      let body = await client.report(project.id, format, ids);
      if (format === 'html' && local) body = await bundleScreenshots(body, client, dir);
      fs.writeFileSync(path.join(dir, REPORT_FILES[format]), body);
    }
    const summary = renderSummary({
      target: config.target,
      runs,
      findings,
      gate,
      options: gateOptions,
      llm: health.llm,
      reportDir: (path.relative(process.cwd(), dir) || '.').replace(/\\/g, '/'),
      ciRunUrl: githubRunUrl(),
      dashboardUrl: local ? undefined : `${client.baseUrl}/?session=${ids[0] ?? ''}`,
      version: VERSION,
    });
    const summaryFile = path.join(dir, 'summary.md');
    fs.writeFileSync(summaryFile, summary);
    writeGithubOutputs(gate.exitCode, findings.length, gate.failing.length, summaryFile, dir);

    log(
      `\n${findings.length} finding(s) in these runs; ${gate.failing.length} at or above "${config.failOn}".`,
    );
    for (const reason of gate.reasons) log(`  ✗ ${reason}`);
    log(`Reports: ${dir}`);
    log(gate.exitCode === EXIT.ok ? 'Result: PASS' : `Result: FAIL (exit ${gate.exitCode})`);
    return { exitCode: gate.exitCode, runs, summaryFile };
  } catch (err) {
    if (err instanceof UnreachableError) {
      log(`Error: ${err.message}`);
      return { exitCode: EXIT.infra, runs };
    }
    if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 409) {
      log(`Error: ${err.message}`);
      return { exitCode: EXIT.usage, runs };
    }
    log(`Error: ${(err as Error).message}`);
    if (local) log(`Server log: ${local.logFile}`);
    return { exitCode: EXIT.infra, runs };
  } finally {
    await agent?.stop();
    await local?.stop();
  }
}

/** The server marks the runner online on its socket handshake; wait for that to land. */
async function waitForAgent(client: GhostiqClient, projectId: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await client.project(projectId)).agentOnline) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new UnreachableError('The embedded runner did not register with the server.');
}

/**
 * A throwaway server disappears with its screenshots: copy the ones the HTML report uses
 * next to it and make the links relative, so the report artifact stands alone.
 */
async function bundleScreenshots(
  html: string,
  client: GhostiqClient,
  dir: string,
): Promise<string> {
  const paths = [...new Set(html.match(/\/screenshots\/[\w.-]+\.png/g) ?? [])];
  if (!paths.length) return html;
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  for (const p of paths) {
    try {
      const res = await fetch(`${client.baseUrl}${p}`, { headers: client.authHeaders() });
      if (res.ok)
        fs.writeFileSync(path.join(dir, p.slice(1)), Buffer.from(await res.arrayBuffer()));
    } catch {
      // keep the link; the image is just missing
    }
  }
  return html.replace(/(["'(])\/screenshots\//g, '$1screenshots/');
}

function githubRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** GitHub Actions: step outputs and the job summary page. No-ops elsewhere. */
function writeGithubOutputs(
  exitCode: number,
  findings: number,
  failing: number,
  summaryFile: string,
  reportDir: string,
) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(
      out,
      [
        `exit-code=${exitCode}`,
        `findings=${findings}`,
        `failing-findings=${failing}`,
        `summary-file=${summaryFile}`,
        `report-dir=${reportDir}`,
        '',
      ].join('\n'),
    );
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${fs.readFileSync(summaryFile, 'utf8')}\n`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new UnreachableError(`Timed out waiting for ${label}`)), ms),
    ),
  ]);
}
