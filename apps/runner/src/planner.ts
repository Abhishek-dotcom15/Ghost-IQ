import type { Healer, PlanResult, Planner } from '@ghostiq/core';
import { HealLocatorResponse, NextActionResponse, type NextActionRequest } from '@ghostiq/shared';

/** Authorization header for servers with sign-in on (project API key). */
export function authHeader(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** Error text from either `{ error: "..." }` or `{ error: { kind, message } }`. */
function errorText(body: unknown, status: number, fallback: string): string {
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return `HTTP ${status}: ${error}`;
  const e = error as { kind?: string; message?: string } | undefined;
  return `${e?.kind ?? `HTTP ${status}`}: ${e?.message ?? fallback}`;
}

/** The heal ladder's model rung, answered by the control plane (keys stay there). */
export function httpHealer(serverUrl: string, sessionId: string, apiKey?: string): Healer {
  return async (request, signal) => {
    const res = await fetch(`${serverUrl}/api/ai/heal-locator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(apiKey) },
      body: JSON.stringify({ sessionId, ...request }),
      signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(body, res.status, 'heal request failed'));
    const parsed = HealLocatorResponse.parse(body);
    return { ...parsed, tokens: parsed.usage.tokensIn + parsed.usage.tokensOut };
  };
}

/**
 * Asks the control plane for the next action. Model keys stay on the server, so a
 * runner on a laptop or in CI never holds LLM credentials.
 */
export class HttpPlanner implements Planner {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey?: string,
  ) {}

  async next(request: NextActionRequest, signal: AbortSignal): Promise<PlanResult> {
    const res = await fetch(`${this.serverUrl}/api/ai/next-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(this.apiKey) },
      body: JSON.stringify(request),
      signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(errorText(body, res.status, 'planner request failed'));
    const parsed = NextActionResponse.parse(body);
    return { action: parsed.action, tokens: parsed.usage.tokensIn + parsed.usage.tokensOut };
  }
}
