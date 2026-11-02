export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'confirmed' | 'dismissed' | 'fixed';

export interface FindingView {
  id: string;
  type: string;
  severity: Severity;
  title: string;
  route: string;
  rule: string | null;
  message: string;
  confidence: 'confirmed' | 'suspected';
  status: FindingStatus;
  triageNote: string | null;
  recurrences: number;
  personas: string[];
  evidence: {
    sessionId: string;
    stepNumber: number | null;
    pageUrl: string | null;
    screenshot: string | null;
    message: string;
    detail?: string;
    request?: { method?: string; url: string; status?: number };
    diffImage?: string;
    baselineImage?: string;
  };
  repro: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  byType: Record<string, number>;
  byPersona: Array<{ persona: string; total: number; unique: number }>;
}

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const SEVERITY_STYLE: Record<Severity, { color: string; label: string }> = {
  critical: { color: '#f43f5e', label: 'Critical' },
  high: { color: '#f97316', label: 'High' },
  medium: { color: '#eab308', label: 'Medium' },
  low: { color: '#60a5fa', label: 'Low' },
  info: { color: '#94a3b8', label: 'Info' },
};

export const TYPE_LABELS: Record<string, string> = {
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
  ui_change: 'UI change (healed locator)',
  flow_regression: 'Flow regression (replay)',
};

export async function fetchFindings(
  projectId: string,
  filters: { status?: string; severity?: string; type?: string; persona?: string },
): Promise<{ findings: FindingView[]; summary: FindingsSummary }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const res = await fetch(`/api/projects/${projectId}/findings?${params}`);
  if (!res.ok) throw new Error(`Failed to load findings (HTTP ${res.status})`);
  return res.json();
}

export async function triageFinding(id: string, status: FindingStatus): Promise<void> {
  const res = await fetch(`/api/findings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Triage failed (HTTP ${res.status})`);
}
