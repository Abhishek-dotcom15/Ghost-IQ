import { SEVERITIES, SEVERITY_RANK, type Severity } from '@ghostiq/shared';

/** What a finished run looks like to an outside system. */
export interface RunCompletedPayload {
  event: 'run.completed';
  project: { id: string; name: string };
  run: {
    id: string;
    name: string;
    persona: string;
    mode: string;
    status: string;
    endReason: string | null;
    summary: string | null;
    targetUrl: string;
    url: string | null;
  };
  findings: {
    total: number;
    bySeverity: Record<Severity, number>;
    top: Array<{ severity: Severity; title: string; route: string }>;
  };
}

export interface WebhookOptions {
  url: string;
  minSeverity?: Severity;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function buildPayload(input: {
  project: { id: string; name: string };
  session: {
    id: string;
    name: string;
    persona: string;
    mode: string;
    status: string;
    endReason: string | null;
    summary: string | null;
    targetUrl: string;
  };
  findings: Array<{ severity: string; title: string; route: string }>;
  publicUrl?: string;
}): RunCompletedPayload {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of input.findings) {
    if ((SEVERITIES as readonly string[]).includes(f.severity))
      bySeverity[f.severity as Severity]++;
  }
  const top = [...input.findings]
    .filter((f): f is typeof f & { severity: Severity } =>
      (SEVERITIES as readonly string[]).includes(f.severity),
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 5)
    .map(({ severity, title, route }) => ({ severity, title, route }));
  return {
    event: 'run.completed',
    project: input.project,
    run: {
      ...input.session,
      url: input.publicUrl
        ? `${input.publicUrl.replace(/\/+$/, '')}/?session=${input.session.id}`
        : null,
    },
    findings: { total: input.findings.length, bySeverity, top },
  };
}

/** Whether this run is worth a notification under the severity threshold. */
export function shouldNotify(payload: RunCompletedPayload, minSeverity?: Severity): boolean {
  if (!minSeverity) return true;
  return SEVERITIES.some(
    (s) => SEVERITY_RANK[s] <= SEVERITY_RANK[minSeverity] && payload.findings.bySeverity[s] > 0,
  );
}

const ICON: Record<Severity, string> = {
  critical: ':red_circle:',
  high: ':large_orange_circle:',
  medium: ':large_yellow_circle:',
  low: ':large_blue_circle:',
  info: ':white_circle:',
};

/** Slack incoming-webhook body (mrkdwn text; works without Block Kit). */
export function slackMessage(p: RunCompletedPayload): { text: string } {
  const status = p.run.status === 'PASSED' ? ':white_check_mark:' : ':x:';
  const counts = SEVERITIES.filter((s) => p.findings.bySeverity[s] > 0)
    .map((s) => `${ICON[s]} ${p.findings.bySeverity[s]} ${s}`)
    .join('  ');
  const lines = [
    `${status} *GhostIQ* ${p.run.mode === 'replay' ? 'replay' : 'run'} *${escapeSlack(p.run.name)}* on ${escapeSlack(p.project.name)}: ${p.run.status} (${p.run.endReason ?? 'unknown'})`,
    p.findings.total ? `Findings: ${counts}` : 'No findings.',
    ...p.findings.top.map((f) => `• ${ICON[f.severity]} ${escapeSlack(f.title)}`),
  ];
  if (p.run.url) lines.push(`<${p.run.url}|Open in GhostIQ>`);
  return { text: lines.join('\n') };
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function isSlackUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

/** Sends the notification. Never throws: a broken webhook must not affect runs. */
export async function sendWebhook(
  payload: RunCompletedPayload,
  options: WebhookOptions,
): Promise<{ sent: boolean; status?: number; error?: string }> {
  if (!shouldNotify(payload, options.minSeverity)) return { sent: false };
  const doFetch = options.fetch ?? fetch;
  const body = isSlackUrl(options.url) ? slackMessage(payload) : payload;
  try {
    const res = await doFetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'GhostIQ-Webhook' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, error: (err as Error).message };
  }
}
