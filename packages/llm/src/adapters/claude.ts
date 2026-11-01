import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LlmError, kindFromStatus } from '../errors.js';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../types.js';

export interface ClaudeAdapterOptions {
  /** Optional: the SDK also resolves ANTHROPIC_API_KEY or an `ant auth login` profile. */
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

/**
 * Claude via the official SDK with structured outputs (`output_config.format`).
 * Sampling parameters are never sent: current Claude models reject non-default
 * temperature. Depth is controlled with `output_config.effort` instead.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: ClaudeAdapterOptions, client?: Anthropic) {
    this.model = options.model;
    // Retries are handled by the core so they are metered and bounded in one place.
    this.client =
      client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        maxRetries: 0,
      });
  }

  async complete(request: AdapterRequest): Promise<AdapterResponse> {
    const ctx = { provider: this.provider, model: this.model };
    let response: Awaited<ReturnType<Anthropic['messages']['parse']>>;
    try {
      response = await this.client.messages.parse(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: {
            format: zodOutputFormat(request.schema),
            ...(request.effort ? { effort: request.effort } : {}),
          },
        },
        { signal: request.signal },
      );
    } catch (err) {
      throw mapClaudeError(err, ctx);
    }

    if (response.stop_reason === 'refusal') {
      const details = response.stop_details;
      const reason = details?.explanation ?? details?.category ?? 'no details';
      throw new LlmError('refusal', `Claude declined the request (${reason})`, ctx);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LlmError('truncated', 'Reply hit max_tokens before finishing', ctx);
    }

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }
    const usage = response.usage;
    return {
      text,
      tokensIn:
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      tokensOut: usage.output_tokens,
    };
  }
}

/** Most specific first: subclasses before their parents. */
export function mapClaudeError(err: unknown, ctx: { provider: 'claude'; model: string }): unknown {
  if (err instanceof Anthropic.APIUserAbortError) {
    return new LlmError('aborted', err.message, { ...ctx, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('timeout', err.message, { ...ctx, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError('network', err.message, { ...ctx, cause: err });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new LlmError('auth', err.message, { ...ctx, status: err.status, cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new LlmError('model_not_found', err.message, { ...ctx, status: err.status, cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError('rate_limit', err.message, {
      ...ctx,
      status: err.status,
      retryAfterMs: retryAfterMs(err.headers?.get('retry-after')),
      cause: err,
    });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new LlmError('server', err.message, { ...ctx, status: err.status, cause: err });
  }
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return new LlmError('bad_request', err.message, { ...ctx, status: err.status, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(kindFromStatus(err.status), err.message, {
      ...ctx,
      status: err.status,
      cause: err,
    });
  }
  return err;
}

function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
