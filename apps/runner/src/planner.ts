import type { Healer, PlanResult, Planner } from '@ghostiq/core';
import { HealLocatorResponse, NextActionResponse, type NextActionRequest } from '@ghostiq/shared';

/** The heal ladder's model rung, answered by the control plane (keys stay there). */
export function httpHealer(serverUrl: string, sessionId: string): Healer {
  return async (request, signal) => {
    const res = await fetch(`${serverUrl}/api/ai/heal-locator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...request }),
      signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (body as { error?: { message?: string } }).error;
      throw new Error(error?.message ?? `heal request failed: HTTP ${res.status}`);
    }
    const parsed = HealLocatorResponse.parse(body);
    return { ...parsed, tokens: parsed.usage.tokensIn + parsed.usage.tokensOut };
  };
}

/**
 * Asks the control plane for the next action. Model keys stay on the server, so a
 * runner on a laptop or in CI never holds LLM credentials.
 */
export class HttpPlanner implements Planner {
  constructor(private readonly serverUrl: string) {}

  async next(request: NextActionRequest, signal: AbortSignal): Promise<PlanResult> {
    const res = await fetch(`${this.serverUrl}/api/ai/next-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (body as { error?: { kind?: string; message?: string } }).error;
      throw new Error(
        `${error?.kind ?? `HTTP ${res.status}`}: ${error?.message ?? 'planner request failed'}`,
      );
    }
    const parsed = NextActionResponse.parse(body);
    return { action: parsed.action, tokens: parsed.usage.tokensIn + parsed.usage.tokensOut };
  }
}
