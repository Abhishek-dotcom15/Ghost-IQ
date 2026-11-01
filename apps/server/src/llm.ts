import {
  createLlmFromConfig,
  parseFallbackList,
  type HealthStatus,
  type LlmCallEvent,
  type LlmClient,
  type LlmConfig,
  type ProviderName,
} from '@ghostiq/llm';
import type { PrismaClient } from './db.js';
import type { Env } from './env.js';
import { demoResponder } from './services/demo-responder.js';

export interface LlmRuntime {
  client: LlmClient;
  /** "demo" means the scripted mock is the primary provider: no AI is involved. */
  mode: 'live' | 'demo';
  /** Why demo mode was chosen, if it was. */
  demoReason?: string;
  health: HealthStatus | null;
}

/**
 * Chooses the provider chain from the environment.
 * - Explicit GHOSTIQ_LLM_PROVIDER wins (and must be correctly configured, or boot fails).
 * - Otherwise: Gemini if a Gemini key exists, else demo mode, said out loud.
 */
export function resolveLlmConfig(env: Env): { config: LlmConfig; demoReason?: string } {
  const providerKeys: Partial<Record<ProviderName, string>> = {
    gemini: env.GEMINI_API_KEY,
    claude: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
  };

  let provider = env.GHOSTIQ_LLM_PROVIDER;
  let demoReason: string | undefined;
  if (!provider) {
    if (env.GHOSTIQ_LLM_API_KEY || env.GEMINI_API_KEY) {
      provider = 'gemini';
    } else {
      provider = 'mock';
      demoReason = 'No GHOSTIQ_LLM_PROVIDER and no API key configured.';
    }
  } else if (provider === 'mock') {
    demoReason = 'GHOSTIQ_LLM_PROVIDER=mock';
  }

  const price =
    env.GHOSTIQ_LLM_PRICE_INPUT !== undefined && env.GHOSTIQ_LLM_PRICE_OUTPUT !== undefined
      ? { input: env.GHOSTIQ_LLM_PRICE_INPUT, output: env.GHOSTIQ_LLM_PRICE_OUTPUT }
      : undefined;

  return {
    demoReason,
    config: {
      primary: {
        provider,
        model: provider === 'mock' ? undefined : env.GHOSTIQ_LLM_MODEL,
        apiKey: env.GHOSTIQ_LLM_API_KEY,
        baseUrl: env.GHOSTIQ_LLM_BASE_URL,
      },
      fallbacks: parseFallbackList(env.GHOSTIQ_LLM_FALLBACK),
      providerKeys,
      timeoutMs: env.GHOSTIQ_LLM_TIMEOUT_MS,
      maxRetries: env.GHOSTIQ_LLM_MAX_RETRIES,
      recordMode: env.GHOSTIQ_LLM_RECORD_MODE,
      fixturesDir: env.GHOSTIQ_LLM_FIXTURES_DIR,
      price,
    },
  };
}

export function createLlmRuntime(env: Env, prisma: PrismaClient): LlmRuntime {
  const { config, demoReason } = resolveLlmConfig(env);
  const client = createLlmFromConfig(config, {
    mockResponder: demoResponder,
    onCall: (event) => void recordCall(prisma, event),
  });
  return {
    client,
    mode: config.primary.provider === 'mock' ? 'demo' : 'live',
    demoReason,
    health: null,
  };
}

async function recordCall(prisma: PrismaClient, event: LlmCallEvent) {
  const sessionId = typeof event.metadata?.sessionId === 'string' ? event.metadata.sessionId : null;
  const data = {
    purpose: event.purpose,
    provider: event.provider,
    model: event.model,
    attempt: event.attempt,
    ok: event.ok,
    errorKind: event.errorKind ?? null,
    errorMessage: event.errorMessage?.slice(0, 1000) ?? null,
    tokensIn: event.tokensIn,
    tokensOut: event.tokensOut,
    latencyMs: event.latencyMs,
    costUsd: event.costUsd,
    cacheHit: event.cacheHit,
    fallbackUsed: event.fallbackUsed,
  };
  try {
    await prisma.llmCall.create({ data: { ...data, sessionId } });
  } catch (err) {
    if (!sessionId) {
      console.error('[llm] failed to record call:', err);
      return;
    }
    // An unknown session id violates the foreign key: keep the call, drop the link.
    await prisma.llmCall
      .create({ data })
      .catch((inner: unknown) => console.error('[llm] failed to record call:', inner));
  }
}

/** Summary used by /healthz, /api/llm/status and the dashboard. */
export function describeLlm(runtime: LlmRuntime) {
  const [primary, ...fallbacks] = runtime.client.chain;
  return {
    mode: runtime.mode,
    demoReason: runtime.demoReason ?? null,
    provider: primary!.provider,
    model: primary!.model,
    fallbacks,
    health: runtime.health,
  };
}
