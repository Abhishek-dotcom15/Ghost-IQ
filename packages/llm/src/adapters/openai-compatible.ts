import { LlmError, kindFromStatus } from '../errors.js';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../types.js';

export interface OpenAiCompatibleOptions {
  /** "openai" for OpenAI-style hosted APIs, "ollama" for a local Ollama server. */
  provider: 'openai' | 'ollama';
  model: string;
  baseUrl: string;
  apiKey?: string;
  /**
   * "json_schema" asks the server to enforce the schema (OpenAI, recent Ollama);
   * "json_object" only forces valid JSON and puts the schema in the prompt.
   */
  responseFormat?: 'json_schema' | 'json_object';
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Any server speaking the OpenAI Chat Completions protocol: OpenAI, Ollama, LM Studio, vLLM, OpenRouter. */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly provider: 'openai' | 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly responseFormat: 'json_schema' | 'json_object';
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.responseFormat = options.responseFormat ?? 'json_schema';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: AdapterRequest): Promise<AdapterResponse> {
    const ctx = { provider: this.provider, model: this.model };
    const system =
      this.responseFormat === 'json_object'
        ? `${request.system}\n\nRespond with JSON matching this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
        : request.system;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: request.user },
      ],
      response_format:
        this.responseFormat === 'json_schema'
          ? {
              type: 'json_schema',
              json_schema: { name: request.schemaName, schema: request.jsonSchema },
            }
          : { type: 'json_object' },
      // Newer OpenAI models only accept max_completion_tokens; Ollama reads max_tokens.
      [this.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']:
        request.maxOutputTokens,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
        throw err;
      throw new LlmError('network', err instanceof Error ? err.message : String(err), {
        ...ctx,
        cause: err,
      });
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new LlmError(kindFromStatus(res.status), `HTTP ${res.status}: ${detail}`, {
        ...ctx,
        status: res.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }

    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new LlmError('refusal', choice.message.refusal, ctx);
    }
    if (choice?.finish_reason === 'length') {
      throw new LlmError('truncated', 'Reply hit the token limit before finishing', ctx);
    }
    return {
      text: choice?.message?.content ?? '',
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}
