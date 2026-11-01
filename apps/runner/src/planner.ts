import type { PlanResult, Planner } from '@ghostiq/core';
import { NextActionResponse, type NextActionRequest } from '@ghostiq/shared';

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
