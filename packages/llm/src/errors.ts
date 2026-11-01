import type { LlmErrorKind, ProviderName } from './types.js';

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server',
]);

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly provider?: ProviderName;
  readonly model?: string;
  readonly status?: number;
  /** Server-suggested wait before retrying, if any. */
  readonly retryAfterMs?: number;

  constructor(
    kind: LlmErrorKind,
    message: string,
    options: {
      provider?: ProviderName;
      model?: string;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
    this.kind = kind;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Maps an HTTP status to an error kind for providers without typed errors. */
export function kindFromStatus(status: number | undefined): LlmErrorKind {
  if (status === undefined) return 'unknown';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Converts anything thrown into an LlmError, keeping LlmErrors as they are. */
export function toLlmError(
  err: unknown,
  context: { provider: ProviderName; model: string },
): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new LlmError(err.name === 'TimeoutError' ? 'timeout' : 'aborted', err.message, {
      ...context,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new LlmError('unknown', message, { ...context, cause: err });
}

/** Human next step for a failed health check. */
export function hintFor(
  kind: LlmErrorKind | undefined,
  provider: ProviderName,
  model: string,
): string | undefined {
  switch (kind) {
    case 'auth':
      return `The ${provider} API key was rejected. Set GHOSTIQ_LLM_API_KEY (or the provider's own key variable).`;
    case 'model_not_found':
      return provider === 'gemini'
        ? `Model "${model}" is not available (it may be retired). Pick a current model from https://ai.google.dev/gemini-api/docs/deprecations and set GHOSTIQ_LLM_MODEL.`
        : `Model "${model}" was not found for ${provider}. Check the model ID and set GHOSTIQ_LLM_MODEL.`;
    case 'rate_limit':
      return 'The provider is rate limiting this key. Wait, lower concurrency, or configure GHOSTIQ_LLM_FALLBACK.';
    case 'network':
    case 'timeout':
      return provider === 'ollama'
        ? 'Could not reach Ollama. Is `ollama serve` running and GHOSTIQ_LLM_BASE_URL correct?'
        : 'Could not reach the provider. Check network access and GHOSTIQ_LLM_BASE_URL.';
    case 'invalid_output':
      return 'The model answered but not in the required JSON shape. Try a more capable model.';
    default:
      return undefined;
  }
}
