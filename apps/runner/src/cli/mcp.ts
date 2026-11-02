import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SEVERITIES, type Severity } from '@ghostiq/shared';
import { z } from 'zod';
import { startAgent, type AgentHandle } from '../agent.js';
import { VERSION } from '../version.js';
import { GhostiqClient, type Session } from './client.js';
import { atOrAbove } from './gate.js';
import { startLocalServer, type LocalServer } from './local-server.js';

export interface McpOptions {
  server?: string;
  project: string;
  headed: boolean;
}

const text = (value: unknown) => ({
  content: [
    {
      type: 'text' as const,
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const failure = (err: unknown) => ({ ...text(`Error: ${(err as Error).message}`), isError: true });

function runSummary(s: Session) {
  return {
    id: s.id,
    name: s.name,
    persona: s.persona,
    mode: s.mode,
    status: s.status,
    endReason: s.endReason,
    summary: s.summary,
    steps: s.steps.map(
      (st) => `${st.stepNumber}. [${st.status}] ${st.description}${st.healed ? ' (healed)' : ''}`,
    ),
    llmCostUsd: s.llmUsage?.costUsd ?? 0,
  };
}

/**
 * `ghostiq mcp`: GhostIQ as tools for coding agents (Claude Code, Cursor, ...), over stdio.
 * The agent can explore a URL with a persona, read findings, replay a run and export it as
 * a Playwright test, so "check my change like a real user would" becomes one tool call.
 */
export async function startMcpServer(options: McpOptions): Promise<void> {
  // stdout is the protocol channel: everything else must go to stderr.
  console.log = (...args: unknown[]) => console.error(...args);

  let local: LocalServer | undefined;
  if (!options.server) local = await startLocalServer({ log: (m) => console.error(m) });
  const client = new GhostiqClient(options.server ?? local!.url);
  const agents = new Map<string, AgentHandle>();

  const ensureRunner = async (projectId: string) => {
    if ((await client.project(projectId)).agentOnline) return;
    if (!agents.has(projectId)) {
      const agent = startAgent(
        projectId,
        {
          serverUrl: client.baseUrl,
          headless: !options.headed,
          trace: true,
          apiKey: client.apiKey,
          log: (m) => console.error(m),
        },
        (m) => console.error(m),
      );
      agents.set(projectId, agent);
      await agent.connected;
    }
    const deadline = Date.now() + 15_000;
    while (!(await client.project(projectId)).agentOnline) {
      if (Date.now() > deadline) throw new Error('The runner did not come online.');
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const projectId = async (name?: string) =>
    (await client.resolveProject(name ?? options.project)).id;

  const server = new McpServer({ name: 'ghostiq', version: VERSION });

  server.registerTool(
    'ghostiq_list_personas',
    {
      description:
        'List GhostIQ personas (virtual users such as happy-path, form-stress-tester, impatient-user, mobile-slow-network). Use their ids with ghostiq_run.',
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.personas());
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'ghostiq_run',
    {
      description:
        'Explore a web app as a persona: a browser agent works towards the goal and records bugs it observes (errors, failed requests, accessibility, security headers, broken links, ...). Waits for the run and returns its steps and findings.',
      inputSchema: {
        target: z.url().describe('URL of the app under test, e.g. http://localhost:3000'),
        persona: z.string().default('happy-path').describe('Persona id'),
        goal: z.string().max(2000).optional().describe('What the persona should try to do'),
        maxSteps: z.number().int().min(1).max(200).optional(),
        project: z.string().optional().describe('GhostIQ project name or id'),
      },
    },
    async ({ target, persona, goal, maxSteps, project }) => {
      try {
        const pid = await projectId(project);
        await ensureRunner(pid);
        const started = await client.startSession({
          projectId: pid,
          targetUrl: target,
          personaId: persona,
          goal,
          budgets: maxSteps ? { maxSteps } : undefined,
        });
        const run = await client.waitForSession(started.id);
        const { findings } = await client.findings(pid, {
          sessions: [run.id],
          status: 'open,confirmed',
        });
        return text({
          run: runSummary(run),
          findings: findings.map((f) => ({
            severity: f.severity,
            title: f.title,
            route: f.route,
            confidence: f.confidence,
            message: f.message.slice(0, 500),
            repro: f.repro,
          })),
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'ghostiq_get_run',
    {
      description: 'Status, steps and end reason of a GhostIQ run.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      try {
        return text(runSummary(await client.session(sessionId)));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'ghostiq_list_findings',
    {
      description:
        'Open findings (deduplicated bugs with evidence and repro steps), most severe first. Optionally only those from one run or at/above a severity.',
      inputSchema: {
        sessionId: z.string().optional(),
        minSeverity: z.enum(SEVERITIES).optional(),
        project: z.string().optional(),
      },
    },
    async ({ sessionId, minSeverity, project }) => {
      try {
        const pid = await projectId(project);
        const { findings } = await client.findings(pid, {
          sessions: sessionId ? [sessionId] : undefined,
          status: 'open,confirmed',
        });
        return text(
          findings
            .filter((f) => !minSeverity || atOrAbove(f.severity, minSeverity as Severity))
            .map((f) => ({
              id: f.id,
              severity: f.severity,
              type: f.type,
              title: f.title,
              route: f.route,
              confidence: f.confidence,
              personas: f.personas,
              message: f.message.slice(0, 800),
              repro: f.repro,
            })),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'ghostiq_replay',
    {
      description:
        'Replay a run that reached its goal, without the planner model: same actions and values, checked against the recorded end state. Renamed controls are healed (and queued for review). Returns each replay and the flakiness score.',
      inputSchema: {
        sessionId: z.string(),
        runs: z.number().int().min(1).max(10).default(1),
      },
    },
    async ({ sessionId, runs }) => {
      try {
        const source = await client.session(sessionId);
        await ensureRunner(source.projectId);
        const { sessions } = await client.replay(sessionId, runs);
        const done = [];
        for (const s of sessions) done.push(runSummary(await client.waitForSession(s.id)));
        return text({ replays: done, ...(await client.replays(sessionId)) });
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'ghostiq_export_test',
    {
      description:
        'Export a run as a self-contained Playwright test (.spec.ts, role-based locators, end-state assertions). Save it in the repo to keep the flow covered.',
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      try {
        const result = await client.exportSpec(sessionId);
        const notes = [
          result.skipped ? `${result.skipped} step(s) could not be exported (see comments).` : '',
          result.secrets.length ? `Set environment variables: ${result.secrets.join(', ')}.` : '',
        ].filter(Boolean);
        return text(`${notes.join(' ')}${notes.length ? '\n\n' : ''}${result.code}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  const shutdown = async () => {
    for (const agent of agents.values()) await agent.stop();
    await local?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error(`GhostIQ MCP server ${VERSION} ready (GhostIQ server ${client.baseUrl}).`);
}
