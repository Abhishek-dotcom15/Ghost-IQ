import { SEVERITIES, SEVERITY_RANK, explainEndReason, type Severity } from '@ghostiq/shared';
import type { Finding, Session } from './client.js';

/** Process exit codes, stable for CI scripts. */
export const EXIT = {
  /** Everything ran and nothing crossed the threshold. */
  ok: 0,
  /** Findings at or above failOn, a failed replay, or (with failOnGoal) a missed goal. */
  gate: 1,
  /** Bad flags or configuration. */
  usage: 2,
  /** GhostIQ itself could not do its job: server unreachable, runner crashed, model down. */
  infra: 3,
} as const;

/** End reasons that mean the tool failed, not the app. */
export const INFRA_END_REASONS: ReadonlySet<string> = new Set([
  'runner_error',
  'runner_disconnected',
  'start_failed',
  'planner_error',
]);

export interface GateOptions {
  failOn: Severity | 'none';
  newOnly: boolean;
  includeSuspected: boolean;
  failOnGoal: boolean;
}

export interface GateResult {
  exitCode: number;
  /** Findings that count towards failOn. */
  failing: Finding[];
  reasons: string[];
}

export function atOrAbove(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold];
}

/**
 * Decides the command's exit code. Infrastructure problems win (a run that never happened
 * must not look like a pass), then the findings threshold, failed replays and missed goals.
 */
export function evaluateGate(
  runs: Session[],
  findings: Finding[],
  options: GateOptions,
): GateResult {
  const reasons: string[] = [];
  const infra = runs.filter((r) => r.endReason && INFRA_END_REASONS.has(r.endReason));
  if (infra.length) {
    for (const r of infra) reasons.push(`${r.persona}: ${r.endReason} - ${r.summary ?? ''}`.trim());
    return { exitCode: EXIT.infra, failing: [], reasons };
  }

  const sessionIds = new Set(runs.map((r) => r.id));
  const failing =
    options.failOn === 'none'
      ? []
      : findings.filter(
          (f) =>
            atOrAbove(f.severity, options.failOn as Severity) &&
            (options.includeSuspected || f.confidence !== 'suspected') &&
            (!options.newOnly ||
              (f.firstSessionId !== undefined && sessionIds.has(f.firstSessionId))),
        );
  if (failing.length) {
    reasons.push(
      `${failing.length} ${options.newOnly ? 'new ' : ''}finding(s) at or above "${options.failOn}"`,
    );
  }
  for (const r of runs.filter((r) => r.endReason === 'replay_diverged')) {
    reasons.push(`replay diverged: ${r.summary ?? r.name}`);
  }
  if (options.failOnGoal) {
    for (const r of runs.filter((r) => r.mode !== 'replay' && r.endReason !== 'goal_met')) {
      reasons.push(`${r.persona} did not reach the goal (${r.endReason})`);
    }
  }
  return { exitCode: reasons.length ? EXIT.gate : EXIT.ok, failing, reasons };
}

export const SUMMARY_MARKER = '<!-- ghostiq-report -->';

const EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: '⚪',
};

export interface SummaryInput {
  target: string;
  runs: Session[];
  findings: Finding[];
  gate: GateResult;
  options: GateOptions;
  llm?: { mode: string; provider: string; model: string };
  reportDir?: string;
  /** Link to the CI run (artifacts live there). */
  ciRunUrl?: string;
  dashboardUrl?: string;
  version: string;
}

/** Markdown for the PR comment and the GitHub job summary. */
export function renderSummary(input: SummaryInput): string {
  const { gate, options } = input;
  const threshold = options.failOn === 'none' ? 'no threshold' : `**${options.failOn}**`;
  const headline =
    gate.exitCode === EXIT.ok
      ? `✅ Passed: no findings at or above ${threshold}`
      : gate.exitCode === EXIT.infra
        ? '⚠️ GhostIQ could not complete the runs'
        : `❌ Failed: ${gate.reasons.join('; ')}`;

  const lines = [
    SUMMARY_MARKER,
    `### 👻 GhostIQ — ${headline}`,
    '',
    `Target: \`${input.target}\`${input.llm ? ` · Model: ${input.llm.mode === 'demo' ? '**demo mode** (scripted, no AI)' : `\`${input.llm.provider}/${input.llm.model}\``}` : ''}`,
    '',
    '| Persona | Result | End reason | Actions | LLM cost |',
    '| --- | --- | --- | ---: | ---: |',
    ...input.runs.map(
      (r) =>
        `| ${cell(r.persona)} | ${r.status === 'PASSED' ? '✅ passed' : r.status === 'FAILED' ? '❌ failed' : r.status} | ${cell(explainEndReason(r.endReason, { summary: r.summary })?.title ?? '-')} (\`${r.endReason ?? '-'}\`) | ${Math.max(0, r.steps.length - 1)} | ${usd(r.llmUsage?.costUsd)} |`,
    ),
    '',
  ];
  // Runs that did not pass: what happened and what to do, in plain words.
  for (const r of input.runs.filter((r) => r.status !== 'PASSED')) {
    const why = explainEndReason(r.endReason, { summary: r.summary });
    if (why)
      lines.push(
        `> **${cell(r.persona)}: ${why.title}.** ${why.detail}${why.fix ? ` _What to do:_ ${why.fix}` : ''}`,
        '',
      );
  }

  if (input.findings.length === 0) {
    lines.push('No findings in these runs.');
  } else {
    const counts = SEVERITIES.map(
      (s) => [s, input.findings.filter((f) => f.severity === s).length] as const,
    )
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${EMOJI[s]} ${n} ${s}`)
      .join(' · ');
    lines.push(`**${input.findings.length} finding(s):** ${counts}`, '');
    const top = input.findings.slice(0, 15);
    lines.push(
      `<details${gate.failing.length ? ' open' : ''}><summary>Top findings</summary>`,
      '',
      '| Severity | Finding | Route | Found by |',
      '| --- | --- | --- | --- |',
      ...top.map(
        (f) =>
          `| ${EMOJI[f.severity]} ${f.severity}${f.confidence === 'suspected' ? ' (suspected)' : ''} | ${cell(f.title)} | \`${cell(f.route)}\` | ${cell(f.personas.join(', '))} |`,
      ),
      ...(input.findings.length > top.length
        ? ['', `…and ${input.findings.length - top.length} more in the HTML report.`]
        : []),
      '',
      '</details>',
    );
  }

  const links: string[] = [];
  if (input.ciRunUrl) links.push(`[CI run and report artifacts](${input.ciRunUrl})`);
  if (input.dashboardUrl) links.push(`[Open in GhostIQ](${input.dashboardUrl})`);
  if (input.reportDir) links.push(`reports in \`${input.reportDir}\``);
  lines.push('', links.length ? `${links.join(' · ')}` : '');
  lines.push(
    `<sub>GhostIQ v${input.version} · gate: ${options.failOn}${options.newOnly ? ' (new only)' : ''}${options.includeSuspected ? ', suspected included' : ''} · exit ${gate.exitCode}</sub>`,
  );
  return lines.join('\n');
}

function cell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 160);
}

function usd(n: number | undefined): string {
  if (n === undefined) return '-';
  if (n === 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
