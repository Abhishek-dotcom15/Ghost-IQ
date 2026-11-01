import type { z } from 'zod';

export type ProviderName = 'gemini' | 'claude' | 'openai' | 'ollama' | 'mock';

/** Effort hint. Providers that support a reasoning-depth control map it; others ignore it. */
export type Effort = 'low' | 'medium' | 'high';

/** What a caller asks for. The reply must validate against `schema`. */
export interface LlmRequest<T> {
  /** Short label used in metering and by the mock provider, e.g. "plan-step". */
  purpose: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Name for the schema in provider requests (letters, digits, underscores). */
  schemaName?: string;
  /** Ignored by providers that reject sampling parameters (current Claude models). */
  temperature?: number;
  maxOutputTokens?: number;
  effort?: Effort;
  /** When set, identical requests within the cache TTL are answered from memory. */
  cacheKey?: string;
  /** Caller context, never sent to real providers: used for metering and by the mock. */
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  /** Estimated USD cost; null when the model has no known price. */
  costUsd: number | null;
}

export interface LlmResult<T> {
  data: T;
  provider: ProviderName;
  model: string;
  usage: LlmUsage;
  cacheHit: boolean;
  /** True when the primary provider failed and a later one in the chain answered. */
  fallbackUsed: boolean;
  /** Physical provider calls made for this request (includes retries and repairs). */
  calls: number;
}

/** One physical provider call, emitted for metering whether it succeeded or not. */
export interface LlmCallEvent {
  purpose: string;
  provider: ProviderName;
  model: string;
  ok: boolean;
  errorKind?: LlmErrorKind;
  errorMessage?: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number | null;
  cacheHit: boolean;
  fallbackUsed: boolean;
  /** "initial", "retry" or "repair". */
  attempt: 'initial' | 'retry' | 'repair';
  metadata?: Record<string, unknown>;
}

export type LlmErrorKind =
  | 'auth'
  | 'model_not_found'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'refusal'
  | 'truncated'
  | 'invalid_output'
  | 'fixture_missing'
  | 'aborted'
  | 'unknown';

/** What the core hands to a provider adapter. */
export interface AdapterRequest {
  purpose: string;
  system: string;
  user: string;
  schema: z.ZodType<unknown>;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  temperature?: number;
  maxOutputTokens: number;
  effort?: Effort;
  metadata?: Record<string, unknown>;
  signal: AbortSignal;
}

/** Raw provider reply: text that should contain JSON, plus token usage. */
export interface AdapterResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** A thin, provider-specific transport. All policy (retry, validation, fallback) lives in the core. */
export interface ProviderAdapter {
  readonly provider: ProviderName;
  readonly model: string;
  complete(request: AdapterRequest): Promise<AdapterResponse>;
}

export interface HealthStatus {
  ok: boolean;
  provider: ProviderName;
  model: string;
  latencyMs: number;
  errorKind?: LlmErrorKind;
  message: string;
  /** Actionable next step when not ok. */
  hint?: string;
}

export interface LlmClient {
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
  /** Tiny real call against the primary provider. */
  healthCheck(): Promise<HealthStatus>;
  /** Ordered provider chain, primary first. */
  readonly chain: ReadonlyArray<{ provider: ProviderName; model: string }>;
}
