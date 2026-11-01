import type { ProviderName } from './types.js';

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
}

/**
 * Standard paid-tier list prices, checked 2026-11-01:
 *   Gemini: https://ai.google.dev/gemini-api/docs/pricing
 *   Claude: Anthropic model table (Haiku 5.5 price applies to prompts up to 100K tokens)
 * Prices change; override with GHOSTIQ_LLM_PRICE_INPUT / GHOSTIQ_LLM_PRICE_OUTPUT.
 */
const PRICES: Record<string, Price> = {
  'gemini:gemini-3.8-flash': { input: 0.75, output: 3.75 }, // rises to 1.50 / 7.50 on 2027-01-01
  'gemini:gemini-3.6-flash': { input: 0.75, output: 3.75 }, // rises to 1.50 / 7.50 on 2027-01-01
  'gemini:gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini:gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini:gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini:gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'claude:claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude:claude-sonnet-5-5': { input: 2, output: 10 },
  'claude:claude-opus-5-5': { input: 4, output: 20 },
  'claude:claude-fable-5-1': { input: 10, output: 50 },
};

export function lookupPrice(provider: ProviderName, model: string, override?: Price): Price | null {
  if (override) return override;
  if (provider === 'mock' || provider === 'ollama') return { input: 0, output: 0 };
  return PRICES[`${provider}:${model}`] ?? null;
}

export function estimateCost(
  price: Price | null,
  tokensIn: number,
  tokensOut: number,
): number | null {
  if (!price) return null;
  return (tokensIn * price.input + tokensOut * price.output) / 1_000_000;
}
