import { z } from 'zod';
import { LlmError, hintFor, toLlmError } from './errors.js';
import { extractJson } from './json.js';
import { estimateCost, lookupPrice, type Price } from './pricing.js';
import type {
  AdapterRequest,
  HealthStatus,
  LlmCallEvent,
  LlmClient,
  LlmRequest,
  LlmResult,
  ProviderAdapter,
} from './types.js';

export interface LlmClientOptions {
  /** Ordered chain: the first is the primary, the rest are fallbacks. */
  providers: ProviderAdapter[];
  /** Overrides the built-in price table for the primary provider. */
  priceOverride?: Price;
  /** Retries per provider for transient errors (rate limit, 5xx, timeout, network). */
  maxRetries?: number;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** Generous by default: thinking models spend output tokens before answering. */
  defaultMaxOutputTokens?: number;
  /** In-memory cache for requests that set `cacheKey`. `false` disables it. */
  cache?: { ttlMs: number; maxEntries: number } | false;
  /** Called after every physical provider call, for metering. Must not throw. */
  onCall?: (event: LlmCallEvent) => void;
  backoffBaseMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxRetries: 2,
  timeoutMs: 60_000,
  defaultMaxOutputTokens: 16_000,
  backoffBaseMs: 500,
  cache: { ttlMs: 10 * 60_000, maxEntries: 500 },
};

const MAX_BACKOFF_MS = 30_000;

interface CacheEntry {
  expires: number;
  value: LlmResult<unknown>;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  if (options.providers.length === 0)
    throw new Error('createLlmClient: at least one provider is required');
  return new DefaultLlmClient(options);
}

class DefaultLlmClient implements LlmClient {
  readonly chain: ReadonlyArray<{ provider: ProviderAdapter['provider']; model: string }>;
  private readonly providers: ProviderAdapter[];
  private readonly opts: Required<Omit<LlmClientOptions, 'priceOverride' | 'onCall' | 'cache'>> & {
    priceOverride?: Price;
    onCall?: (event: LlmCallEvent) => void;
    cache: { ttlMs: number; maxEntries: number } | false;
  };
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: LlmClientOptions) {
    this.providers = options.providers;
    this.chain = options.providers.map((p) => ({ provider: p.provider, model: p.model }));
    this.opts = {
      providers: options.providers,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      defaultMaxOutputTokens: options.defaultMaxOutputTokens ?? DEFAULTS.defaultMaxOutputTokens,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      cache: options.cache === undefined ? DEFAULTS.cache : options.cache,
      priceOverride: options.priceOverride,
      onCall: options.onCall,
    };
  }

  async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const cacheKey = request.cacheKey ? `${request.purpose}:${request.cacheKey}` : undefined;
    const cached = cacheKey ? this.readCache<T>(cacheKey) : undefined;
    if (cached) {
      this.emit({
        purpose: request.purpose,
        provider: cached.provider,
        model: cached.model,
        ok: true,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        costUsd: 0,
        cacheHit: true,
        fallbackUsed: false,
        attempt: 'initial',
        metadata: request.metadata,
      });
      return { ...cached, cacheHit: true, usage: { ...cached.usage, latencyMs: 0, costUsd: 0 } };
    }

    const failures: Array<{ adapter: ProviderAdapter; error: LlmError }> = [];
    for (let i = 0; i < this.providers.length; i++) {
      const adapter = this.providers[i]!;
      try {
        const result = await this.runWithProvider(adapter, request, i > 0, i === 0);
        if (cacheKey) this.writeCache(cacheKey, result);
        return result;
      } catch (err) {
        const llmErr = toLlmError(err, adapter);
        if (llmErr.kind === 'aborted') throw llmErr; // caller cancelled: do not fall back
        failures.push({ adapter, error: llmErr });
      }
    }

    const last = failures[failures.length - 1]!;
    if (failures.length === 1) throw last.error;
    const summary = failures
      .map(
        ({ adapter, error }) =>
          `${adapter.provider}/${adapter.model}: ${error.kind} (${error.message})`,
      )
      .join('; ');
    throw new LlmError(last.error.kind, `All providers failed: ${summary}`, {
      provider: last.adapter.provider,
      model: last.adapter.model,
      status: last.error.status,
      cause: last.error,
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    const adapter = this.providers[0]!;
    const started = Date.now();
    try {
      await this.runWithProvider(
        adapter,
        {
          purpose: 'health-check',
          system: 'You are a connectivity check. Reply with JSON only.',
          user: 'Reply with {"ok": true}.',
          schema: z.object({ ok: z.boolean() }),
          schemaName: 'health_check',
          maxOutputTokens: 2048,
          effort: 'low',
        },
        false,
        true,
        0, // fail fast: no retries at boot
      );
      return {
        ok: true,
        provider: adapter.provider,
        model: adapter.model,
        latencyMs: Date.now() - started,
        message: 'Model reachable and returning valid structured output.',
      };
    } catch (err) {
      const e = toLlmError(err, adapter);
      return {
        ok: false,
        provider: adapter.provider,
        model: adapter.model,
        latencyMs: Date.now() - started,
        errorKind: e.kind,
        message: e.message,
        hint: hintFor(e.kind, adapter.provider, adapter.model),
      };
    }
  }

  private async runWithProvider<T>(
    adapter: ProviderAdapter,
    request: LlmRequest<T>,
    fallbackUsed: boolean,
    isPrimary: boolean,
    maxRetries = this.opts.maxRetries,
  ): Promise<LlmResult<T>> {
    const price = lookupPrice(
      adapter.provider,
      adapter.model,
      isPrimary ? this.opts.priceOverride : undefined,
    );
    const jsonSchema = toProviderJsonSchema(request.schema);
    const base: Omit<AdapterRequest, 'user' | 'signal'> = {
      purpose: request.purpose,
      system: request.system,
      schema: request.schema as z.ZodType<unknown>,
      jsonSchema,
      schemaName: request.schemaName ?? request.purpose.replace(/[^a-zA-Z0-9_]/g, '_'),
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens ?? this.opts.defaultMaxOutputTokens,
      effort: request.effort,
      metadata: request.metadata,
    };

    let user = request.user;
    let attempt: LlmCallEvent['attempt'] = 'initial';
    let retries = 0;
    let repaired = false;
    let calls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let latencyMs = 0;

    for (;;) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const callStarted = Date.now();
      const eventBase = {
        purpose: request.purpose,
        provider: adapter.provider,
        model: adapter.model,
        cacheHit: false,
        fallbackUsed,
        attempt,
        metadata: request.metadata,
      };

      let text: string;
      try {
        const response = await adapter.complete({ ...base, user, signal });
        const callMs = Date.now() - callStarted;
        calls++;
        tokensIn += response.tokensIn;
        tokensOut += response.tokensOut;
        latencyMs += callMs;
        text = response.text;

        const parsed = parseAndValidate(text, request.schema);
        const callCost = estimateCost(price, response.tokensIn, response.tokensOut);
        if (parsed.ok) {
          this.emit({
            ...eventBase,
            ok: true,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
            latencyMs: callMs,
            costUsd: callCost,
          });
          return {
            data: parsed.data,
            provider: adapter.provider,
            model: adapter.model,
            usage: {
              tokensIn,
              tokensOut,
              latencyMs,
              costUsd: estimateCost(price, tokensIn, tokensOut),
            },
            cacheHit: false,
            fallbackUsed,
            calls,
          };
        }

        this.emit({
          ...eventBase,
          ok: false,
          errorKind: 'invalid_output',
          errorMessage: parsed.error,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          latencyMs: callMs,
          costUsd: callCost,
        });
        if (repaired) {
          throw new LlmError(
            'invalid_output',
            `Output failed schema validation after repair: ${parsed.error}`,
            {
              provider: adapter.provider,
              model: adapter.model,
            },
          );
        }
        repaired = true;
        attempt = 'repair';
        user = repairPrompt(request.user, text, parsed.error);
        continue;
      } catch (raw) {
        if (raw instanceof LlmError && raw.kind === 'invalid_output') throw raw;
        const err = classifyAbort(raw, adapter, request.signal, timeout);
        this.emit({
          ...eventBase,
          ok: false,
          errorKind: err.kind,
          errorMessage: err.message.slice(0, 500),
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: Date.now() - callStarted,
          costUsd: 0,
        });
        if (err.retryable && retries < maxRetries) {
          retries++;
          attempt = 'retry';
          await this.opts.sleep(this.backoff(retries, err.retryAfterMs));
          continue;
        }
        throw err;
      }
    }
  }

  private backoff(retry: number, retryAfterMs?: number): number {
    const exponential = this.opts.backoffBaseMs * 2 ** (retry - 1);
    const jitter = Math.random() * this.opts.backoffBaseMs;
    return Math.min(MAX_BACKOFF_MS, Math.max(exponential + jitter, retryAfterMs ?? 0));
  }

  private emit(event: LlmCallEvent) {
    try {
      this.opts.onCall?.(event);
    } catch {
      // metering must never break a request
    }
  }

  private readCache<T>(key: string): LlmResult<T> | undefined {
    if (!this.opts.cache) return undefined;
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value as LlmResult<T>;
  }

  private writeCache(key: string, value: LlmResult<unknown>) {
    if (!this.opts.cache) return;
    this.cache.set(key, { value, expires: Date.now() + this.opts.cache.ttlMs });
    while (this.cache.size > this.opts.cache.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function parseAndValidate<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch {
    return { ok: false, error: 'Reply was not valid JSON.' };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}

function repairPrompt(originalUser: string, badOutput: string, error: string): string {
  return [
    originalUser,
    '',
    '---',
    'Your previous reply did not match the required JSON schema.',
    `Problems: ${error}`,
    `Previous reply (truncated): ${badOutput.slice(0, 1500)}`,
    'Reply again with only a JSON value that matches the schema exactly.',
  ].join('\n');
}

/** Distinguishes our timeout from a caller cancellation, whatever the adapter threw. */
function classifyAbort(
  raw: unknown,
  adapter: ProviderAdapter,
  callerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
): LlmError {
  const ctx = { provider: adapter.provider, model: adapter.model };
  if (callerSignal?.aborted)
    return new LlmError('aborted', 'Request cancelled by caller', { ...ctx, cause: raw });
  if (timeout.aborted)
    return new LlmError('timeout', 'Provider call timed out', { ...ctx, cause: raw });
  return toLlmError(raw, ctx);
}

/** JSON Schema for provider-side constrained decoding; drops the `$schema` marker some APIs reject. */
function toProviderJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
