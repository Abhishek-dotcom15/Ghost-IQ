import { ApiError, GoogleGenAI } from '@google/genai';
import { LlmError, kindFromStatus } from '../errors.js';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../types.js';

export interface GeminiAdapterOptions {
  apiKey: string;
  model: string;
}

/** Minimal surface of the SDK we use, so tests can inject a fake. */
export interface GeminiModelsApi {
  generateContent: GoogleGenAI['models']['generateContent'];
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini' as const;
  readonly model: string;
  private readonly models: GeminiModelsApi;

  constructor(options: GeminiAdapterOptions, models?: GeminiModelsApi) {
    this.model = options.model;
    this.models = models ?? new GoogleGenAI({ apiKey: options.apiKey }).models;
  }

  async complete(request: AdapterRequest): Promise<AdapterResponse> {
    const ctx = { provider: this.provider, model: this.model };
    let response: Awaited<ReturnType<GeminiModelsApi['generateContent']>>;
    try {
      response = await this.models.generateContent({
        model: this.model,
        contents: request.user,
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: request.jsonSchema,
          maxOutputTokens: request.maxOutputTokens,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          abortSignal: request.signal,
        },
      });
    } catch (err) {
      if (err instanceof ApiError) {
        throw new LlmError(kindFromStatus(err.status), err.message, {
          ...ctx,
          status: err.status,
          cause: err,
        });
      }
      if (err instanceof TypeError) {
        // undici reports connection failures as TypeError("fetch failed")
        throw new LlmError('network', err.message, { ...ctx, cause: err });
      }
      throw err;
    }

    const finish = String(response.candidates?.[0]?.finishReason ?? '');
    if (finish === 'MAX_TOKENS') {
      throw new LlmError('truncated', 'Reply hit maxOutputTokens before finishing', ctx);
    }
    if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(finish)) {
      throw new LlmError('refusal', `Gemini blocked the reply (${finish})`, ctx);
    }

    const usage = response.usageMetadata;
    return {
      text: response.text ?? '',
      tokensIn: usage?.promptTokenCount ?? 0,
      // thinking tokens are billed as output
      tokensOut: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    };
  }
}
