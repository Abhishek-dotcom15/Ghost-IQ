import type { StepIssue } from '@ghostiq/shared';

/**
 * Pure checks over responses. The driver feeds them; each returns raw issues that the
 * server's findings engine turns into deduplicated, severity-ranked Findings.
 */

/** Hygiene headers every HTML document should carry. */
export function checkSecurityHeaders(headers: Record<string, string>, url: string): StepIssue[] {
  const issues: StepIssue[] = [];
  const has = (name: string) => headers[name] !== undefined;
  const isHttps = url.startsWith('https:');

  if (!has('content-security-policy')) {
    issues.push({
      kind: 'security_header',
      rule: 'content-security-policy',
      message: 'No Content-Security-Policy header: injected scripts are not restricted.',
      url,
    });
  }
  if ((headers['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') {
    issues.push({
      kind: 'security_header',
      rule: 'x-content-type-options',
      message: 'X-Content-Type-Options: nosniff is missing.',
      url,
    });
  }
  const csp = headers['content-security-policy'] ?? '';
  if (!has('x-frame-options') && !/frame-ancestors/i.test(csp)) {
    issues.push({
      kind: 'security_header',
      rule: 'x-frame-options',
      message: 'No X-Frame-Options or CSP frame-ancestors: the page can be framed (clickjacking).',
      url,
    });
  }
  if (isHttps && !has('strict-transport-security')) {
    issues.push({
      kind: 'security_header',
      rule: 'strict-transport-security',
      message: 'HTTPS page without Strict-Transport-Security.',
      url,
    });
  }
  if (has('x-powered-by')) {
    issues.push({
      kind: 'info_exposure',
      rule: 'x-powered-by',
      message: `Server reveals its stack: X-Powered-By: ${headers['x-powered-by']}`,
      url,
      detail: headers['x-powered-by'],
    });
  }
  return issues;
}

/** Cookie flags. Only cookies that look like sessions or auth are held to HttpOnly. */
export function checkCookies(setCookies: string[], url: string): StepIssue[] {
  const issues: StepIssue[] = [];
  const isHttps = url.startsWith('https:');
  for (const raw of setCookies) {
    const [pair = '', ...attrs] = raw.split(';').map((s) => s.trim());
    const name = pair.split('=')[0] ?? '';
    const flags = attrs.map((a) => a.toLowerCase());
    const missing: string[] = [];
    const sensitive = /sess|auth|token|sid|jwt|login/i.test(name);
    if (sensitive && !flags.includes('httponly')) missing.push('HttpOnly');
    if (!flags.some((f) => f.startsWith('samesite='))) missing.push('SameSite');
    if (isHttps && !flags.includes('secure')) missing.push('Secure');
    if (missing.length) {
      issues.push({
        kind: 'insecure_cookie',
        rule: name,
        message: `Cookie "${name}" is set without ${missing.join(', ')}.`,
        url,
        detail: raw.replace(/=([^;]{4})[^;]*/, '=$1…'),
      });
    }
  }
  return issues;
}

const STACK_TRACE = [
  /\bat [\w$.<>]+ \([^()\s]+:\d+:\d+\)/, // V8 / Node
  /Traceback \(most recent call last\)/, // Python
  /\bat [\w.$]+\([\w]+\.java:\d+\)/, // Java
  /\.(php|rb|py|cs|go):\d+/,
];

// "key": "value" pairs that look like real secrets (not empty, not placeholders).
const SECRET_PAIR =
  /"([\w-]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)[\w-]*)"\s*:\s*"([^"]{6,})"/i;
const SECRET_VALUE =
  /\b(sk_live_[0-9a-zA-Z]{10,}|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{30,}|xox[bp]-[0-9A-Za-z-]{10,})/;

/** Scans a response body for leaked stack traces and secrets. */
export function scanBody(body: string, url: string, status: number): StepIssue[] {
  const issues: StepIssue[] = [];
  const text = body.slice(0, 200_000);
  const trace = STACK_TRACE.map((re) => re.exec(text)).find(Boolean);
  if (trace) {
    issues.push({
      kind: 'info_exposure',
      rule: 'stack-trace',
      message: `Response from ${new URL(url).pathname} (HTTP ${status}) contains a server stack trace.`,
      url,
      status,
      detail: excerpt(text, trace.index),
    });
  }
  const pair = SECRET_PAIR.exec(text);
  const value = SECRET_VALUE.exec(text);
  if (pair || value) {
    const name = pair ? pair[1] : 'credential';
    issues.push({
      kind: 'info_exposure',
      rule: 'secret',
      message: `Response from ${new URL(url).pathname} exposes a secret (${name}).`,
      url,
      status,
      // Never store the secret itself.
      detail: `${name}: ${'•'.repeat(8)}`,
    });
  }
  return issues;
}

function excerpt(text: string, index: number): string {
  return text.slice(Math.max(0, index - 80), index + 160).replace(/\s+/g, ' ');
}

/**
 * Detects the same state-changing request sent twice in quick succession with both
 * succeeding: the signature of a missing idempotency guard (double orders, duplicates).
 */
export class DuplicateSubmissionDetector {
  private readonly recent = new Map<string, number>();

  constructor(private readonly windowMs = 1500) {}

  /** Call for each successful (2xx) non-GET response. Returns an issue on the second hit. */
  observe(method: string, url: string, body: string | null, at: number): StepIssue | null {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
    const key = `${method} ${url} ${body ?? ''}`;
    const previous = this.recent.get(key);
    this.recent.set(key, at);
    if (previous !== undefined && at - previous <= this.windowMs) {
      return {
        kind: 'duplicate_submission',
        method,
        message: `${method} ${new URL(url).pathname} succeeded twice within ${at - previous} ms with the same body: the action is not idempotent.`,
        url,
        detail: body ? body.slice(0, 300) : undefined,
      };
    }
    return null;
  }
}
