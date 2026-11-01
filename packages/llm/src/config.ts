import { ClaudeAdapter } from './adapters/claude.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { MockAdapter, type MockResponder } from './adapters/mock.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { createLlmClient, type LlmClientOptions } from './client.js';
import type { Price } from './pricing.js';
import { withRecording, type RecordMode } from './recording.js';
import type { LlmClient, ProviderAdapter, ProviderName } from './types.js';

export const PROVIDERS: readonly ProviderName[] = ['gemini', 'claude', 'openai', 'ollama', 'mock'];

/**
 * Defaults are small, cheap models: an exploration run makes many short calls.
 * Change with GHOSTIQ_LLM_MODEL. openai and ollama have no default on purpose.
 */
export const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  gemini: 'gemini-3.5-flash-lite',
  claude: 'claude-haiku-5-5',
  mock: 'demo',
};

const DEFAULT_BASE_URLS: Partial<Record<ProviderName, string>> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

export interface ProviderSpec {
  provider: ProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface LlmConfig {
  primary: ProviderSpec;
  /** Tried in order when the primary fails. */
  fallbacks: ProviderSpec[];
  /** Keys for fallback providers (the primary uses `primary.apiKey` first). */
  providerKeys: Partial<Record<ProviderName, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  recordMode?: RecordMode | 'off';
  fixturesDir?: string;
  price?: Price;
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

/** Parses "claude,mock" or "claude:claude-sonnet-5-5,ollama:llama3.2". */
export function parseFallbackList(value: string | undefined): ProviderSpec[] {
  if (!value?.trim()) return [];
  return value.split(',').map((raw) => {
    const [name, ...modelParts] = raw.trim().split(':');
    const provider = name?.trim() as ProviderName;
    if (!PROVIDERS.includes(provider)) {
      throw new LlmConfigError(
        `Unknown fallback provider "${name}". Use one of: ${PROVIDERS.join(', ')}`,
      );
    }
    const model = modelParts.join(':').trim();
    return model ? { provider, model } : { provider };
  });
}

export function buildAdapter(
  spec: ProviderSpec,
  deps: {
    mockResponder?: MockResponder;
    providerKeys?: Partial<Record<ProviderName, string>>;
  } = {},
): ProviderAdapter {
  const model = spec.model ?? DEFAULT_MODELS[spec.provider];
  if (!model) {
    throw new LlmConfigError(`Provider "${spec.provider}" needs a model: set GHOSTIQ_LLM_MODEL.`);
  }
  const apiKey = spec.apiKey ?? deps.providerKeys?.[spec.provider];

  switch (spec.provider) {
    case 'gemini':
      if (!apiKey)
        throw new LlmConfigError(
          'Gemini needs an API key: set GHOSTIQ_LLM_API_KEY or GEMINI_API_KEY.',
        );
      return new GeminiAdapter({ apiKey, model });
    case 'claude':
      return new ClaudeAdapter({ apiKey, model, baseUrl: spec.baseUrl });
    case 'openai':
    case 'ollama':
      if (spec.provider === 'openai' && !apiKey && !spec.baseUrl) {
        throw new LlmConfigError(
          'OpenAI needs an API key: set GHOSTIQ_LLM_API_KEY or OPENAI_API_KEY.',
        );
      }
      return new OpenAiCompatibleAdapter({
        provider: spec.provider,
        model,
        apiKey,
        baseUrl: spec.baseUrl ?? DEFAULT_BASE_URLS[spec.provider]!,
      });
    case 'mock':
      if (!deps.mockResponder) throw new LlmConfigError('The mock provider needs a responder.');
      return new MockAdapter(deps.mockResponder, model);
  }
}

/** Builds the full client: adapters for the chain, optional record/replay, metering hook. */
export function createLlmFromConfig(
  config: LlmConfig,
  deps: { mockResponder?: MockResponder; onCall?: LlmClientOptions['onCall'] } = {},
): LlmClient {
  const specs = [config.primary, ...config.fallbacks];
  const adapters = specs.map((spec) => {
    const adapter = buildAdapter(spec, {
      mockResponder: deps.mockResponder,
      providerKeys: config.providerKeys,
    });
    if (config.recordMode && config.recordMode !== 'off' && adapter.provider !== 'mock') {
      return withRecording(adapter, {
        mode: config.recordMode,
        dir: config.fixturesDir ?? 'fixtures/llm',
      });
    }
    return adapter;
  });

  return createLlmClient({
    providers: adapters,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    priceOverride: config.price,
    onCall: deps.onCall,
  });
}
