import {
  AGENT_NOTE_KINDS,
  normalizeRoute,
  type FindingType,
  type InputStrategy,
  type Severity,
  type StepIssue,
} from '@ghostiq/shared';

/** A finding as produced by an oracle, before deduplication and persistence. */
export interface RawFinding {
  type: FindingType;
  severity: Severity;
  title: string;
  /** Route template, or "*" for site-wide findings. */
  route: string;
  rule?: string;
  message: string;
  confidence: 'confirmed' | 'suspected';
  detail?: string;
  request?: { method?: string; url: string; status?: number };
}

const SITE_WIDE = '*';

const A11Y_SEVERITY: Record<NonNullable<StepIssue['impact']>, Severity> = {
  critical: 'critical',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

const INFO_EXPOSURE_SEVERITY: Record<string, Severity> = {
  secret: 'high',
  'stack-trace': 'medium',
  'x-powered-by': 'low',
};

/**
 * Maps a raw step issue to a finding. Agent notes (blocked navigation, skipped
 * destructive clicks, ...) describe the agent, not the app, and return null.
 */
export function issueToFinding(issue: StepIssue, pageUrl: string): RawFinding | null {
  if (AGENT_NOTE_KINDS.has(issue.kind)) return null;
  const target = issue.url ?? pageUrl;
  const route = normalizeRoute(target);
  // Page-level oracles record the page they actually looked at; prefer it over the URL
  // the step ended on (they differ when an action navigates).
  const pageRoute = normalizeRoute(issue.url && isPageScoped(issue.kind) ? issue.url : pageUrl);
  const method = issue.method ?? 'GET';
  const base = { message: issue.message, detail: issue.detail, confidence: 'confirmed' as const };

  switch (issue.kind) {
    case 'page_error':
      return {
        ...base,
        type: 'runtime_error',
        severity: 'high',
        route: pageRoute,
        title: `Uncaught error on ${pageRoute}: ${firstLine(issue.message)}`,
      };
    case 'console_error':
      return {
        ...base,
        type: 'runtime_error',
        severity: 'medium',
        route: pageRoute,
        title: `Console error on ${pageRoute}: ${firstLine(issue.message)}`,
      };
    case 'http_error': {
      const status = issue.status ?? 0;
      return {
        ...base,
        type: 'network_error',
        severity: status >= 500 ? 'high' : 'medium',
        route,
        rule: String(status),
        title: `${method} ${route} returns ${status}`,
        request: { method, url: target, status },
      };
    }
    case 'request_failed':
      return {
        ...base,
        type: 'network_error',
        severity: 'medium',
        route,
        rule: 'failed',
        title: `${method} ${route} fails to complete`,
        request: { method, url: target },
      };
    case 'broken_link':
      return {
        ...base,
        type: 'broken_link',
        severity: 'medium',
        route,
        title: `Broken link: ${route} returns ${issue.status ?? 404}`,
        request: { url: target, status: issue.status },
      };
    case 'redirect_loop':
      return {
        ...base,
        type: 'redirect_loop',
        severity: 'medium',
        route,
        title: `Redirect loop at ${route}`,
        request: { url: target },
      };
    case 'hanging_request':
      return {
        ...base,
        type: 'hanging_request',
        severity: 'high',
        route,
        title: `${method} ${route} never responds`,
        request: { method, url: target },
      };
    case 'duplicate_submission':
      return {
        ...base,
        type: 'duplicate_submission',
        severity: 'high',
        route,
        title: `${method} ${route} accepts duplicate submissions`,
        request: { method, url: target },
      };
    case 'a11y':
      return {
        ...base,
        type: 'accessibility',
        severity: A11Y_SEVERITY[issue.impact ?? 'moderate'],
        route: pageRoute,
        rule: issue.rule,
        title: `${issue.rule}: ${firstLine(issue.message)} on ${pageRoute}`,
      };
    case 'security_header':
      return {
        ...base,
        type: 'security_headers',
        severity: 'low',
        route: SITE_WIDE,
        rule: issue.rule,
        title: `Missing security header: ${issue.rule}`,
      };
    case 'insecure_cookie':
      return {
        ...base,
        type: 'insecure_cookie',
        severity: 'medium',
        route: SITE_WIDE,
        rule: issue.rule,
        title: `Cookie "${issue.rule}" is missing security flags`,
      };
    case 'info_exposure': {
      const rule = issue.rule ?? 'exposure';
      const siteWide = rule === 'x-powered-by';
      return {
        ...base,
        type: 'info_exposure',
        severity: INFO_EXPOSURE_SEVERITY[rule] ?? 'medium',
        route: siteWide ? SITE_WIDE : route,
        rule,
        title: siteWide
          ? 'Server advertises its software (X-Powered-By)'
          : `${rule === 'secret' ? 'Secret' : 'Stack trace'} exposed by ${route}`,
        request: siteWide ? undefined : { url: target, status: issue.status },
      };
    }
    case 'script_injection':
      return {
        ...base,
        type: 'script_injection',
        severity: 'critical',
        route: pageRoute,
        title: `Input executed as script on ${pageRoute} (XSS)`,
      };
    case 'layout_overflow':
      return {
        ...base,
        type: 'layout_overflow',
        severity: 'medium',
        route: pageRoute,
        title: `${pageRoute} overflows the viewport horizontally`,
      };
    case 'web_vital':
      return issue.rule === 'lcp'
        ? {
            ...base,
            type: 'slow_page',
            severity: 'low',
            route: pageRoute,
            rule: 'lcp',
            title: `Slow Largest Contentful Paint on ${pageRoute}`,
          }
        : {
            ...base,
            type: 'layout_shift',
            severity: 'low',
            route: pageRoute,
            rule: 'cls',
            title: `Layout shifts while loading ${pageRoute}`,
          };
    case 'locator_healed':
      // Not necessarily a bug: a renamed control breaks every script that targeted it.
      return {
        ...base,
        type: 'ui_change',
        severity: 'info',
        route: pageRoute,
        rule: issue.rule,
        confidence: 'suspected',
        title: `Control changed on ${pageRoute}: ${firstLine(issue.message)}`,
      };
    case 'replay_diverged':
      return {
        ...base,
        type: 'flow_regression',
        severity: 'high',
        route: pageRoute,
        rule: issue.rule,
        title: `Recorded flow no longer works on ${pageRoute}: ${firstLine(issue.message)}`,
      };
    default:
      return null;
  }
}

const PAGE_SCOPED: ReadonlySet<StepIssue['kind']> = new Set([
  'locator_healed',
  'replay_diverged',
  'page_error',
  'console_error',
  'a11y',
  'script_injection',
  'layout_overflow',
  'web_vital',
]);

function isPageScoped(kind: StepIssue['kind']): boolean {
  return PAGE_SCOPED.has(kind);
}

/**
 * Stable identity for deduplication: type + route + rule, or a normalized message when
 * there is no rule (numbers, quotes and ids stripped so "line 42" == "line 43").
 */
export function fingerprint(f: Pick<RawFinding, 'type' | 'route' | 'rule' | 'message'>): string {
  const key = f.rule ?? normalizeMessage(f.message);
  return `${f.type}|${f.route}|${key}`;
}

export function normalizeMessage(message: string): string {
  return firstLine(message)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/["'`][^"'`]*["'`]/g, '<str>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200);
}

// ---------------------------------------------------------------- run-level oracles

export interface NetworkSample {
  method: string;
  url: string;
  status: number;
  latencyMs: number;
}

/** Endpoint average above this is a finding (the threshold from the original README). */
export const SLOW_AVG_MS = 800;
const VERY_SLOW_AVG_MS = 3000;

/** Groups a run's requests by route and flags slow ones. */
export function slowEndpointFindings(samples: NetworkSample[]): RawFinding[] {
  const groups = new Map<string, NetworkSample[]>();
  for (const s of samples) {
    if (s.status === 0) continue; // failures and hangs are other oracles
    const key = `${s.method} ${normalizeRoute(s.url)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const findings: RawFinding[] = [];
  for (const [key, group] of groups) {
    const latencies = group.map((s) => s.latencyMs).sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    if (avg <= SLOW_AVG_MS) continue;
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;
    const [method, route] = key.split(' ') as [string, string];
    findings.push({
      type: 'slow_endpoint',
      severity: avg > VERY_SLOW_AVG_MS ? 'high' : 'medium',
      route,
      title: `${method} ${route} is slow (avg ${Math.round(avg)} ms)`,
      message: `${group.length} call(s): avg ${Math.round(avg)} ms, p95 ${p95} ms, max ${latencies.at(-1)} ms (threshold ${SLOW_AVG_MS} ms).`,
      confidence: 'confirmed',
      request: { method, url: group[0]!.url },
    });
  }
  return findings;
}

export interface StepForValidation {
  stepNumber: number;
  action: string;
  value: string | null;
  input: { strategy: InputStrategy; kind: string; field: string } | null;
  network: NetworkSample[];
}

/** Strategies whose values a correct app should reject. */
const INVALID_STRATEGIES: ReadonlySet<InputStrategy> = new Set([
  'boundary',
  'naughty_strings',
  'empty',
]);
const LOOKBACK_STEPS = 6;

/**
 * Heuristic validation oracle: an invalid generated value was typed, then a state-changing
 * request succeeded (2xx) with no 4xx in between. Reported as "suspected": some boundary
 * values are legitimately acceptable.
 */
export function validationFindings(
  steps: StepForValidation[],
): Array<RawFinding & { stepNumber: number }> {
  const findings: Array<RawFinding & { stepNumber: number }> = [];
  let windowStart = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    for (const req of step.network) {
      if (req.method === 'GET') continue;
      if (req.status >= 400 && req.status < 500) {
        windowStart = i + 1; // the app rejected what came before: validation works here
        continue;
      }
      if (req.status < 200 || req.status >= 300) continue;
      const suspicious = steps
        .slice(Math.max(windowStart, i - LOOKBACK_STEPS), i + 1)
        .filter((s) => s.action === 'FILL' && s.input && INVALID_STRATEGIES.has(s.input.strategy));
      windowStart = i + 1;
      if (suspicious.length === 0) continue;
      const route = normalizeRoute(req.url);
      const fields = suspicious.map(
        (s) =>
          `"${s.input!.field}" = ${s.value === '••••••' ? '(secret)' : JSON.stringify(s.value ?? '')} [${s.input!.strategy}]`,
      );
      findings.push({
        type: 'validation',
        severity: 'medium',
        route,
        // One finding per endpoint, whatever values triggered it.
        rule: req.method,
        title: `${req.method} ${route} accepted invalid input`,
        message: `The server answered ${req.status} after the form was filled with values a correct app should reject: ${fields.join('; ')}.`,
        confidence: 'suspected',
        request: { method: req.method, url: req.url, status: req.status },
        stepNumber: step.stepNumber,
      });
    }
  }
  return findings;
}
