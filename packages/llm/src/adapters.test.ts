import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeAdapter, mapClaudeError } from './adapters/claude.js';
import { GeminiAdapter, type GeminiModelsApi } from './adapters/gemini.js';
import { MockAdapter } from './adapters/mock.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { LlmConfigError, buildAdapter, parseFallbackList } from './config.js';
import { LlmError } from './errors.js';
import { withRecording } from './recording.js';
import type { AdapterRequest } from './types.js';

const schema = z.object({ ok: z.boolean() });
const baseRequest = (): AdapterRequest => ({
  purpose: 'plan-step',
  system: 'sys',
  user: 'usr',
  schema,
  jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
  schemaName: 'plan_step',
  maxOutputTokens: 1000,
  temperature: 0.2,
  signal: new AbortController().signal,
});

describe('OpenAiCompatibleAdapter', () => {
  function fakeFetch(response: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const okBody = {
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  };

  it('sends an OpenAI request with a JSON schema response format', async () => {
    const { impl, calls } = fakeFetch(Response.json(okBody));
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openai',
      model: 'm',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1/',
      fetchImpl: impl,
    });

    const res = await adapter.complete(baseRequest());

    expect(res).toEqual({ text: '{"ok":true}', tokensIn: 12, tokensOut: 3 });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'plan_step' },
    });
    expect(body.max_completion_tokens).toBe(1000);
    expect(body.max_tokens).toBeUndefined();
  });

  it('uses max_tokens and no auth header for Ollama', async () => {
    const { impl, calls } = fakeFetch(Response.json(okBody));
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: impl,
    });
    await adapter.complete(baseRequest());
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.max_tokens).toBe(1000);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('maps 429 to a retryable rate_limit error with retry-after', async () => {
    const { impl } = fakeFetch(
      new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
    );
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openai',
      model: 'm',
      apiKey: 'k',
      baseUrl: 'http://x',
      fetchImpl: impl,
    });
    const err = (await adapter.complete(baseRequest()).catch((e: unknown) => e)) as LlmError;
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfterMs: 3000, retryable: true });
  });

  it('flags truncated replies and connection failures', async () => {
    const truncated = fakeFetch(
      Response.json({ choices: [{ message: { content: '{"o' }, finish_reason: 'length' }] }),
    );
    const a = new OpenAiCompatibleAdapter({
      provider: 'ollama',
      model: 'm',
      baseUrl: 'http://x',
      fetchImpl: truncated.impl,
    });
    await expect(a.complete(baseRequest())).rejects.toMatchObject({ kind: 'truncated' });

    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const b = new OpenAiCompatibleAdapter({
      provider: 'ollama',
      model: 'm',
      baseUrl: 'http://x',
      fetchImpl: failing,
    });
    await expect(b.complete(baseRequest())).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('GeminiAdapter', () => {
  it('requests JSON with the schema and counts thinking tokens as output', async () => {
    let captured: unknown;
    const models: GeminiModelsApi = {
      generateContent: (async (params: unknown) => {
        captured = params;
        return {
          text: '{"ok":true}',
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, thoughtsTokenCount: 30 },
        };
      }) as unknown as GeminiModelsApi['generateContent'],
    };
    const adapter = new GeminiAdapter({ apiKey: 'k', model: 'gemini-3.5-flash-lite' }, models);

    const res = await adapter.complete(baseRequest());

    expect(res).toEqual({ text: '{"ok":true}', tokensIn: 50, tokensOut: 35 });
    expect(captured).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        systemInstruction: 'sys',
      },
    });
  });

  it('maps a 404 ApiError to model_not_found', async () => {
    const models: GeminiModelsApi = {
      generateContent: (async () => {
        throw new ApiError({ message: 'models/gemini-2.5-flash is not found', status: 404 });
      }) as unknown as GeminiModelsApi['generateContent'],
    };
    const adapter = new GeminiAdapter({ apiKey: 'k', model: 'gemini-2.5-flash' }, models);
    await expect(adapter.complete(baseRequest())).rejects.toMatchObject({
      kind: 'model_not_found',
      status: 404,
    });
  });

  it('reports safety blocks as refusals', async () => {
    const models: GeminiModelsApi = {
      generateContent: (async () => ({
        text: '',
        candidates: [{ finishReason: 'SAFETY' }],
      })) as unknown as GeminiModelsApi['generateContent'],
    };
    const adapter = new GeminiAdapter({ apiKey: 'k', model: 'g' }, models);
    await expect(adapter.complete(baseRequest())).rejects.toMatchObject({ kind: 'refusal' });
  });
});

describe('ClaudeAdapter', () => {
  function fakeClient(result: unknown) {
    let captured: unknown;
    const client = {
      messages: {
        parse: async (params: unknown) => {
          captured = params;
          return result;
        },
      },
    } as unknown as Anthropic;
    return { client, captured: () => captured as Record<string, unknown> };
  }

  it('uses structured output and effort, never sends temperature, sums cached input tokens', async () => {
    const fake = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 100,
        output_tokens: 7,
      },
    });
    const adapter = new ClaudeAdapter({ model: 'claude-haiku-5-5' }, fake.client);

    const res = await adapter.complete({ ...baseRequest(), effort: 'low' });

    expect(res).toEqual({ text: '{"ok":true}', tokensIn: 115, tokensOut: 7 });
    const params = fake.captured();
    expect(params).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1000, system: 'sys' });
    expect(params).not.toHaveProperty('temperature');
    expect((params.output_config as Record<string, unknown>).effort).toBe('low');
    expect((params.output_config as Record<string, unknown>).format).toBeDefined();
  });

  it('turns refusals and truncation into typed errors', async () => {
    const refusal = new ClaudeAdapter(
      { model: 'm' },
      fakeClient({
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'no' },
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      }).client,
    );
    await expect(refusal.complete(baseRequest())).rejects.toMatchObject({ kind: 'refusal' });

    const truncated = new ClaudeAdapter(
      { model: 'm' },
      fakeClient({
        stop_reason: 'max_tokens',
        content: [],
        usage: { input_tokens: 1, output_tokens: 1000 },
      }).client,
    );
    await expect(truncated.complete(baseRequest())).rejects.toMatchObject({ kind: 'truncated' });
  });

  it('maps SDK error classes to error kinds', () => {
    const ctx = { provider: 'claude' as const, model: 'm' };
    const headers = new Headers({ 'retry-after': '2' });
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [403, 'auth'],
      [404, 'model_not_found'],
      [429, 'rate_limit'],
      [500, 'server'],
      [529, 'server'],
      [400, 'bad_request'],
    ];
    for (const [status, kind] of cases) {
      const err = mapClaudeError(
        Anthropic.APIError.generate(status, {}, `status ${status}`, headers),
        ctx,
      );
      expect(err, `status ${status}`).toMatchObject({ kind });
    }
    const limited = mapClaudeError(
      Anthropic.APIError.generate(429, {}, 'x', headers),
      ctx,
    ) as LlmError;
    expect(limited.retryAfterMs).toBe(2000);
    expect(mapClaudeError(new Anthropic.APIConnectionTimeoutError(), ctx)).toMatchObject({
      kind: 'timeout',
    });
    expect(mapClaudeError(new Anthropic.APIConnectionError({ message: 'x' }), ctx)).toMatchObject({
      kind: 'network',
    });
  });
});

describe('withRecording', () => {
  it('records real exchanges and replays them without the provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-fixtures-'));
    let calls = 0;
    const real = new MockAdapter(() => {
      calls++;
      return { ok: true };
    }, 'recorded-model');

    const recorded = await withRecording(real, { mode: 'record', dir }).complete(baseRequest());
    const replayed = await withRecording(real, { mode: 'replay', dir }).complete(baseRequest());

    expect(calls).toBe(1);
    expect(replayed).toEqual(recorded);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('fails clearly when a fixture is missing in replay mode', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-fixtures-'));
    const adapter = withRecording(new MockAdapter(() => ({ ok: true })), { mode: 'replay', dir });
    await expect(adapter.complete(baseRequest())).rejects.toMatchObject({
      kind: 'fixture_missing',
    });
  });
});

describe('config', () => {
  it('parses fallback lists with optional models', () => {
    expect(parseFallbackList('claude, ollama:llama3.2 ,mock')).toEqual([
      { provider: 'claude' },
      { provider: 'ollama', model: 'llama3.2' },
      { provider: 'mock' },
    ]);
    expect(parseFallbackList(undefined)).toEqual([]);
    expect(() => parseFallbackList('gpt')).toThrow(LlmConfigError);
  });

  it('applies default models and validates required settings', () => {
    expect(buildAdapter({ provider: 'gemini', apiKey: 'k' }).model).toBe('gemini-3.5-flash-lite');
    expect(buildAdapter({ provider: 'claude', apiKey: 'k' }).model).toBe('claude-haiku-5-5');
    expect(() => buildAdapter({ provider: 'gemini' })).toThrow(/API key/);
    expect(() => buildAdapter({ provider: 'ollama' })).toThrow(/needs a model/);
    expect(buildAdapter({ provider: 'ollama', model: 'llama3.2' }).provider).toBe('ollama');
    expect(() => buildAdapter({ provider: 'mock' })).toThrow(/responder/);
  });
});
