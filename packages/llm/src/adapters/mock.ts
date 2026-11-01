import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../types.js';

/**
 * Returns the reply for a request. Return an object (serialized to JSON) or a raw
 * string (to test invalid output). Throw to simulate provider errors.
 */
export type MockResponder = (request: AdapterRequest) => unknown;

/**
 * Deterministic, offline provider. Used as the labelled demo mode when no model is
 * configured and as a test double in CI. It is not AI.
 */
export class MockAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  readonly model: string;
  private readonly responder: MockResponder;

  constructor(responder: MockResponder, model = 'demo') {
    this.responder = responder;
    this.model = model;
  }

  async complete(request: AdapterRequest): Promise<AdapterResponse> {
    const value = await this.responder(request);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      text,
      tokensIn: estimateTokens(request.system) + estimateTokens(request.user),
      tokensOut: estimateTokens(text),
    };
  }
}

/** Rough 4-characters-per-token estimate, good enough for budgeting in demo mode. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
