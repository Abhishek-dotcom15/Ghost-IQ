/** Thin REST client for the GhostIQ control plane (used by the CLI and the MCP server). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** The server could not be reached at all (exit code 3, not a test failure). */
export class UnreachableError extends Error {}

export interface Session {
  id: string;
  name: string;
  projectId: string;
  persona: string;
  personaId: string | null;
  mode: string;
  status: string;
  endReason: string | null;
  summary: string | null;
  goal: string | null;
  seed: number | null;
  targetUrl: string;
  traceUrl: string | null;
  flakinessScore: number;
  startedAt: string;
  endedAt: string | null;
  steps: Array<{
    stepNumber: number;
    action: string;
    status: string;
    description: string;
    healed?: boolean;
  }>;
  llmUsage?: { calls: number; costUsd: number; tokensIn: number; tokensOut: number };
}

export interface Finding {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  route: string;
  rule: string | null;
  message: string;
  confidence: 'confirmed' | 'suspected';
  status: string;
  recurrences: number;
  personas: string[];
  repro: string[];
  evidence: {
    pageUrl?: string | null;
    request?: { method?: string; url: string; status?: number };
  };
  fingerprint?: string;
  firstSessionId?: string;
}

export interface Project {
  id: string;
  name: string;
  agentOnline: boolean;
}

export class GhostiqClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new UnreachableError(
        `Cannot reach the GhostIQ server at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      const error = (parsed as { error?: unknown })?.error;
      const message =
        typeof error === 'string'
          ? error
          : typeof (error as { message?: string })?.message === 'string'
            ? (error as { message: string }).message
            : `HTTP ${res.status}`;
      throw new ApiError(res.status, `${method} ${path}: ${message}`, parsed);
    }
    return (raw ? text : text ? JSON.parse(text) : null) as T;
  }

  health() {
    return this.request<{ ok: boolean; llm: { mode: string; provider: string; model: string } }>(
      'GET',
      '/healthz',
    );
  }

  projects() {
    return this.request<Project[]>('GET', '/api/projects');
  }

  createProject(name: string) {
    return this.request<Project>('POST', '/api/projects', { name });
  }

  /** Accepts a project id or name; creates the project when the name does not exist. */
  async resolveProject(idOrName: string, create = true): Promise<Project> {
    const all = await this.projects();
    const found = all.find((p) => p.id === idOrName) ?? all.find((p) => p.name === idOrName);
    if (found) return found;
    if (!create) throw new ApiError(404, `Project "${idOrName}" not found`);
    return { ...(await this.createProject(idOrName)), agentOnline: false };
  }

  async project(id: string) {
    return this.request<Project>('GET', `/api/projects/${encodeURIComponent(id)}`);
  }

  personas() {
    return this.request<Array<{ id: string; name: string; description: string; source: string }>>(
      'GET',
      '/api/personas',
    );
  }

  startSession(body: Record<string, unknown>) {
    return this.request<Session>('POST', '/api/sessions', body);
  }

  session(id: string) {
    return this.request<Session>('GET', `/api/sessions/${encodeURIComponent(id)}`);
  }

  cancel(id: string) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(id)}/cancel`);
  }

  findings(projectId: string, query: { sessions?: string[]; status?: string } = {}) {
    const params = new URLSearchParams();
    if (query.sessions?.length) params.set('sessions', query.sessions.join(','));
    if (query.status) params.set('status', query.status);
    return this.request<{ findings: Finding[] }>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/findings?${params}`,
    );
  }

  report(projectId: string, format: string, sessions: string[]) {
    const params = new URLSearchParams({ format, sessions: sessions.join(',') });
    return this.request<string>(
      'GET',
      `/api/projects/${encodeURIComponent(projectId)}/report?${params}`,
      undefined,
      true,
    );
  }

  exportSpec(sessionId: string) {
    return this.request<{ code: string; skipped: number; secrets: string[]; healed: number[] }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/export/spec?format=json`,
    );
  }

  replay(sessionId: string, runs: number) {
    return this.request<{ sessions: Session[] }>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/replay`,
      { runs },
    );
  }

  replays(sessionId: string) {
    return this.request<{ flakinessScore: number; passed: number; failed: number }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/replays`,
    );
  }

  /** Polls until the run leaves PENDING/RUNNING. */
  async waitForSession(
    id: string,
    options: { timeoutMs?: number; intervalMs?: number; onProgress?: (s: Session) => void } = {},
  ): Promise<Session> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    let lastSteps = -1;
    for (;;) {
      const s = await this.session(id);
      if (s.steps.length !== lastSteps) {
        lastSteps = s.steps.length;
        options.onProgress?.(s);
      }
      if (s.status !== 'RUNNING' && s.status !== 'PENDING') return s;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for run ${id}`);
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
    }
  }
}
