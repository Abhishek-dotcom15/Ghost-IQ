import {
  FINDING_TYPE_LABELS,
  SEVERITY_RANK,
  type FindingType,
  type Severity,
} from '@ghostiq/shared';
import type { Evidence } from './engine.js';

/** Finding as exposed by the API and rendered in reports. */
export interface FindingView {
  id: string;
  type: FindingType;
  severity: Severity;
  title: string;
  route: string;
  rule: string | null;
  message: string;
  confidence: 'confirmed' | 'suspected';
  status: string;
  triageNote: string | null;
  recurrences: number;
  personas: string[];
  evidence: Evidence;
  repro: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ReportInput {
  title: string;
  target: string;
  generatedAt: string;
  run?: {
    id: string;
    persona: string;
    goal: string | null;
    status: string;
    endReason: string | null;
    summary: string | null;
    seed: number | null;
    traceUrl: string | null;
    steps: number;
  };
  findings: FindingView[];
}

export const REPORT_FORMATS = ['json', 'html', 'junit', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function sortFindings(findings: FindingView[]): FindingView[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.recurrences - a.recurrences,
  );
}

export function countBySeverity(findings: FindingView[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function renderReport(
  input: ReportInput,
  format: ReportFormat,
): { body: string; contentType: string; ext: string } {
  const findings = sortFindings(input.findings);
  switch (format) {
    case 'json':
      return {
        body: JSON.stringify({ ...input, summary: countBySeverity(findings), findings }, null, 2),
        contentType: 'application/json',
        ext: 'json',
      };
    case 'junit':
      return { body: junit({ ...input, findings }), contentType: 'application/xml', ext: 'xml' };
    case 'sarif':
      return {
        body: JSON.stringify(sarif({ ...input, findings }), null, 2),
        contentType: 'application/sarif+json',
        ext: 'sarif',
      };
    case 'html':
      return {
        body: html({ ...input, findings }),
        contentType: 'text/html; charset=utf-8',
        ext: 'html',
      };
  }
}

// ---------------------------------------------------------------- JUnit

/** One testsuite; each finding is a failing testcase so CI test tabs list them. */
function junit(input: ReportInput): string {
  const cases = input.findings.map((f) => {
    const name = xml(`[${f.severity}] ${f.title}`);
    const body = xml([f.message, '', 'Steps to reproduce:', ...f.repro].join('\n'));
    return `    <testcase classname="ghostiq.${f.type}" name="${name}">\n      <failure type="${f.type}" message="${xml(f.title)}">${body}</failure>\n    </testcase>`;
  });
  const runCase = input.run
    ? `    <testcase classname="ghostiq.run" name="${xml(`Goal: ${input.run.goal ?? 'explore'}`)}">${
        input.run.status === 'PASSED'
          ? ''
          : `\n      <failure type="${xml(input.run.endReason ?? 'failed')}" message="${xml(input.run.summary ?? '')}"/>\n    `
      }</testcase>`
    : '';
  const tests = input.findings.length + (input.run ? 1 : 0);
  const failures = input.findings.length + (input.run && input.run.status !== 'PASSED' ? 1 : 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="GhostIQ" tests="${tests}" failures="${failures}">`,
    `  <testsuite name="${xml(input.title)}" tests="${tests}" failures="${failures}" timestamp="${input.generatedAt}">`,
    ...(runCase ? [runCase] : []),
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

function xml(text: string): string {
  // XML 1.0 forbids control characters other than tab, newline and carriage return.
  const allowed = Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join('');
  return allowed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- SARIF 2.1.0

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};

/** Numeric severity GitHub uses to rank security results (0-10). */
const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '3.0',
  info: '1.0',
};

function sarif(input: ReportInput) {
  const types = [...new Set(input.findings.map((f) => f.type))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'GhostIQ',
            informationUri: 'https://github.com/Abhishek-dotcom15/Ghost-IQ',
            rules: types.map((type) => ({
              id: `ghostiq/${type}`,
              name: FINDING_TYPE_LABELS[type],
              shortDescription: { text: FINDING_TYPE_LABELS[type] },
              properties: { tags: ['ghostiq', 'exploratory-testing'] },
            })),
          },
        },
        results: input.findings.map((f) => ({
          ruleId: `ghostiq/${f.type}`,
          level: SARIF_LEVEL[f.severity],
          message: { text: `${f.title}. ${f.message}` },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: locationUri(input.target, f) } },
              logicalLocations: [{ name: f.route, kind: 'resource' }],
            },
          ],
          partialFingerprints: { ghostiqFindingId: f.id },
          properties: {
            severity: f.severity,
            'security-severity': SECURITY_SEVERITY[f.severity],
            confidence: f.confidence,
            recurrences: f.recurrences,
            personas: f.personas,
            reproSteps: f.repro,
          },
        })),
      },
    ],
  };
}

function locationUri(target: string, f: FindingView): string {
  if (f.evidence.request?.url) return f.evidence.request.url;
  if (f.evidence.pageUrl) return f.evidence.pageUrl;
  try {
    return new URL(f.route === '*' ? '/' : f.route.replace(/:id/g, '1'), target).toString();
  } catch {
    return target;
  }
}

// ---------------------------------------------------------------- HTML

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#b91c1c',
  high: '#c2410c',
  medium: '#a16207',
  low: '#1d4ed8',
  info: '#475569',
};

/** Self-contained report page. Every value is escaped: page content can be hostile. */
function html(input: ReportInput): string {
  const counts = countBySeverity(input.findings);
  const esc = htmlEscape;
  const rows = input.findings
    .map(
      (f) => `<details class="finding">
  <summary><span class="sev" style="background:${SEVERITY_COLOR[f.severity]}">${f.severity}</span>
  <strong>${esc(f.title)}</strong> <span class="muted">${esc(FINDING_TYPE_LABELS[f.type])} · ${esc(f.route)} · seen ${f.recurrences}× · ${esc(f.personas.join(', '))}${f.confidence === 'suspected' ? ' · suspected' : ''}</span></summary>
  <p>${esc(f.message)}</p>
  ${f.evidence.detail ? `<pre>${esc(f.evidence.detail)}</pre>` : ''}
  ${f.evidence.request ? `<p class="muted">Request: ${esc(`${f.evidence.request.method ?? 'GET'} ${f.evidence.request.url}${f.evidence.request.status ? ` → ${f.evidence.request.status}` : ''}`)}</p>` : ''}
  <h4>Steps to reproduce</h4>
  <ol>${f.repro.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
</details>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#0f172a;background:#fff}
h1{margin-bottom:.25rem}.muted{color:#64748b}.counts{display:flex;gap:.5rem;flex-wrap:wrap;margin:1rem 0}
.counts span,.sev{color:#fff;border-radius:999px;padding:.1rem .6rem;font-size:12px;text-transform:uppercase}
.finding{border:1px solid #e2e8f0;border-radius:8px;padding:.75rem 1rem;margin:.5rem 0}
summary{cursor:pointer}pre{background:#f1f5f9;padding:.5rem;border-radius:6px;white-space:pre-wrap;word-break:break-all}
</style></head><body>
<h1>${esc(input.title)}</h1>
<p class="muted">Target ${esc(input.target)} · generated ${esc(input.generatedAt)} by GhostIQ</p>
${
  input.run
    ? `<p>Run <code>${esc(input.run.id)}</code> · persona <strong>${esc(input.run.persona)}</strong> · seed ${input.run.seed ?? '-'} · ${input.run.steps} steps · <strong>${esc(input.run.status)}</strong> (${esc(input.run.endReason ?? '')}) ${esc(input.run.summary ?? '')}</p>
<p class="muted">Goal: ${esc(input.run.goal ?? '')}</p>`
    : ''
}
<div class="counts">${(Object.keys(counts) as Severity[])
    .map((s) => `<span style="background:${SEVERITY_COLOR[s]}">${counts[s]} ${s}</span>`)
    .join('')}</div>
${rows || '<p>No findings.</p>'}
</body></html>
`;
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
