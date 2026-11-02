import { z } from 'zod';

/**
 * A Finding is a deduplicated, severity-ranked defect: many raw step issues across steps,
 * runs and personas fold into one Finding with a recurrence count and evidence.
 */

export const FINDING_TYPES = [
  'runtime_error',
  'network_error',
  'broken_link',
  'redirect_loop',
  'slow_endpoint',
  'hanging_request',
  'duplicate_submission',
  'validation',
  'accessibility',
  'security_headers',
  'insecure_cookie',
  'info_exposure',
  'script_injection',
  'layout_overflow',
  'layout_shift',
  'slow_page',
  'visual_regression',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Lower is worse; used for sorting and fail-on thresholds. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const FINDING_STATUSES = ['open', 'confirmed', 'dismissed', 'fixed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FindingTriage = z.object({
  status: z.enum(FINDING_STATUSES),
  note: z.string().max(1000).optional(),
});

export const FINDING_TYPE_LABELS: Record<FindingType, string> = {
  runtime_error: 'Runtime error',
  network_error: 'Server / network error',
  broken_link: 'Broken link',
  redirect_loop: 'Redirect loop',
  slow_endpoint: 'Slow endpoint',
  hanging_request: 'Hanging request',
  duplicate_submission: 'Duplicate submission',
  validation: 'Missing validation',
  accessibility: 'Accessibility',
  security_headers: 'Security headers',
  insecure_cookie: 'Insecure cookie',
  info_exposure: 'Information exposure',
  script_injection: 'Script injection',
  layout_overflow: 'Layout overflow',
  layout_shift: 'Layout shift',
  slow_page: 'Slow page',
  visual_regression: 'Visual regression',
};

// Numbers, UUIDs, long hex, and long tokens that contain a digit (not long readable slugs).
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})$/i;

/**
 * Route template for grouping: path only, with id-like segments replaced by ":id".
 * "http://x/api/products/3?y=1" -> "/api/products/:id".
 */
export function normalizeRoute(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://placeholder').pathname;
  } catch {
    pathname = url.split(/[?#]/)[0] ?? url;
  }
  const route = pathname
    .split('/')
    .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return route.length > 1 ? route.replace(/\/+$/, '') : route || '/';
}
