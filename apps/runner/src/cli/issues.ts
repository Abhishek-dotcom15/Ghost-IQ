import { createHash } from 'node:crypto';
import type { Severity } from '@ghostiq/shared';
import type { Finding } from './client.js';
import { atOrAbove } from './gate.js';

/**
 * Findings -> GitHub issues, idempotently: each issue carries a hidden marker derived from
 * the finding's fingerprint (stable across databases), so re-running never duplicates.
 */

export function markerFor(
  finding: Pick<Finding, 'fingerprint' | 'type' | 'route' | 'title'>,
): string {
  const key = finding.fingerprint ?? `${finding.type}|${finding.route}|${finding.title}`;
  return `<!-- ghostiq:${createHash('sha256').update(key).digest('hex').slice(0, 16)} -->`;
}

export function issueTitle(f: Finding): string {
  return `[GhostIQ] ${f.title}`.slice(0, 250);
}

export function issueBody(f: Finding): string {
  const req = f.evidence.request;
  const lines = [
    `**Severity:** ${f.severity}${f.confidence === 'suspected' ? ' (suspected: heuristic, please verify)' : ''}  `,
    `**Type:** ${f.type}  `,
    `**Route:** \`${f.route}\`  `,
    `**Found by:** ${f.personas.join(', ') || '-'} · seen ${f.recurrences} time(s)`,
    '',
    '### What happened',
    '',
    '```',
    f.message.slice(0, 3000),
    '```',
  ];
  if (req)
    lines.push(
      '',
      `**Request:** \`${req.method ?? 'GET'} ${req.url}\`${req.status ? ` → ${req.status}` : ''}`,
    );
  if (f.evidence.pageUrl) lines.push(`**Page:** ${f.evidence.pageUrl}`);
  if (f.repro.length) {
    lines.push(
      '',
      '### Steps to reproduce',
      '',
      ...f.repro.slice(0, 20).map((s, i) => `${i + 1}. ${s}`),
    );
  }
  lines.push(
    '',
    '---',
    '_Reported by GhostIQ. Closing this issue does not change the finding in GhostIQ._',
    markerFor(f),
  );
  return lines.join('\n');
}

export interface IssuePlan {
  create: Finding[];
  existing: Array<{ finding: Finding; issue: number }>;
}

/** Which findings need a new issue, given the markers already present in the repo. */
export function planIssues(
  findings: Finding[],
  existing: Map<string, number>,
  minSeverity: Severity,
  includeSuspected: boolean,
): IssuePlan {
  const plan: IssuePlan = { create: [], existing: [] };
  const seen = new Set<string>();
  for (const f of findings) {
    if (!atOrAbove(f.severity, minSeverity)) continue;
    if (!includeSuspected && f.confidence === 'suspected') continue;
    const marker = markerFor(f);
    if (seen.has(marker)) continue;
    seen.add(marker);
    const issue = existing.get(marker);
    if (issue !== undefined) plan.existing.push({ finding: f, issue });
    else plan.create.push(f);
  }
  return plan;
}

export interface GithubTarget {
  repo: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

const MARKER = /<!-- ghostiq:[0-9a-f]{16} -->/;

async function gh(target: GithubTarget, method: string, path: string, body?: unknown) {
  const res = await (target.fetch ?? fetch)(`${target.apiUrl ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${target.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ghostiq-cli',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new Error(
      `GitHub ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  return res.json();
}

/** Markers of GhostIQ issues already in the repo (open and closed, label "ghostiq"). */
export async function existingMarkers(target: GithubTarget): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (let page = 1; page <= 10; page++) {
    const issues = (await gh(
      target,
      'GET',
      `/repos/${target.repo}/issues?labels=ghostiq&state=all&per_page=100&page=${page}`,
    )) as Array<{ number: number; body: string | null }>;
    for (const issue of issues) {
      const m = issue.body?.match(MARKER);
      if (m) found.set(m[0], issue.number);
    }
    if (issues.length < 100) break;
  }
  return found;
}

export async function createIssue(target: GithubTarget, f: Finding): Promise<number> {
  const created = (await gh(target, 'POST', `/repos/${target.repo}/issues`, {
    title: issueTitle(f),
    body: issueBody(f),
    labels: ['ghostiq', `severity:${f.severity}`],
  })) as { number: number };
  return created.number;
}
