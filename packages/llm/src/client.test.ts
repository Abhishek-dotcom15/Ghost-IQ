import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockAdapter } from './adapters/mock.js';
import { createLlmClient } from './client.js';
import { LlmError } from './errors.js';
import { extractJson } from './json.js';
import type { AdapterRequest, LlmCallEvent, ProviderAdapter } from './types.js';

const Answer = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });

const request = {
  purpose: 'test',
  system: 'You answer questions.',
  user: 'What is 2+2?',
  schema: Answer,
};

const noSleep = async (_ms: number) => {};

/** Adapter scripted with a queue of replies or errors. */
function scripted(
  provider: ProviderAdapter['provider'],
  model: string,
  steps: Array<unknown | Error>,
): ProviderAdapter & { seen: AdapterRequest[] } {
  const seen: AdapterRequest[] = [];
  return {
    provider,
    model,
    seen,
    async complete(req) {
      seen.push(req);
      const step = steps.shift();
      if (step instanceof Error) throw step;
      const text = typeof step === 'string' ? step : JSON.stringify(step);
      return { text, tokensIn: 100, tokensOut: 20 };
    },
  };
}

describe('createLlmClient', () => {
  it('returns schema-validated data with usage and cost', async () => {
    const events: LlmCallEvent[] = [];
    const client = createLlmClient({
      providers: [scripted('gemini', 'gemini-3.5-flash-lite', [{ answer: '4', confidence: 0.9 }])],
      onCall: (e) => events.push(e),
      sleep: noSleep,
    });

    const result = await client.generate(request);

    expect(result.data).toEqual({ answer: '4', confidence: 0.9 });
    expect(result).toMatchObject({
      provider: 'gemini',
      fallbackUsed: false,
      cacheHit: false,
      calls: 1,
    });
    expect(result.usage.tokensIn).toBe(100);
    // $0.30 / $2.50 per 1M tokens
    expect(result.usage.costUsd).toBeCloseTo((100 * 0.3 + 20 * 2.5) / 1e6, 12);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: true, attempt: 'initial', purpose: 'test' });
  });

  it('sends a JSON Schema derived from the zod schema', async () => {
    const adapter = scripted('mock', 'demo', [{ answer: 'x', confidence: 1 }]);
    await createLlmClient({ providers: [adapter], sleep: noSleep }).generate(request);
    expect(adapter.seen[0]!.jsonSchema).toMatchObject({
      type: 'object',
      properties: { answer: { type: 'string' }, confidence: { type: 'number' } },
    });
    expect(adapter.seen[0]!.jsonSchema).not.toHaveProperty('$schema');
  });

  it('repairs invalid output once, feeding the validation errors back', async () => {
    const events: LlmCallEvent[] = [];
    const adapter = scripted('mock', 'demo', [{ answer: 4 }, { answer: '4', confidence: 0.5 }]);
    const client = createLlmClient({
      providers: [adapter],
      onCall: (e) => events.push(e),
      sleep: noSleep,
    });

    const result = await client.generate(request);

    expect(result.data.answer).toBe('4');
    expect(result.calls).toBe(2);
    expect(result.usage.tokensIn).toBe(200);
    expect(adapter.seen[1]!.user).toContain('did not match the required JSON schema');
    expect(adapter.seen[1]!.user).toContain('confidence');
    expect(events.map((e) => [e.attempt, e.ok])).toEqual([
      ['initial', false],
      ['repair', true],
    ]);
  });

  it('gives up with invalid_output after one failed repair', async () => {
    const client = createLlmClient({
      providers: [scripted('mock', 'demo', ['not json at all', '{"answer": 1}'])],
      sleep: noSleep,
    });
    await expect(client.generate(request)).rejects.toMatchObject({ kind: 'invalid_output' });
  });

  it('retries transient errors with backoff, honouring retry-after', async () => {
    const sleep = vi.fn(noSleep);
    const adapter = scripted('claude', 'claude-haiku-5-5', [
      new LlmError('rate_limit', 'slow down', { retryAfterMs: 5000 }),
      new LlmError('server', 'overloaded'),
      { answer: 'ok', confidence: 1 },
    ]);
    const client = createLlmClient({ providers: [adapter], sleep, backoffBaseMs: 100 });

    const result = await client.generate(request);

    expect(result.data.answer).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0]![0]).toBeGreaterThanOrEqual(5000);
    expect(sleep.mock.calls[1]![0]).toBeGreaterThanOrEqual(200);
  });

  it('stops retrying after maxRetries', async () => {
    const adapter = scripted('claude', 'claude-haiku-5-5', [
      new LlmError('server', 'a'),
      new LlmError('server', 'b'),
      new LlmError('server', 'c'),
    ]);
    const client = createLlmClient({ providers: [adapter], sleep: noSleep, maxRetries: 2 });
    await expect(client.generate(request)).rejects.toMatchObject({ kind: 'server' });
    expect(adapter.seen).toHaveLength(3);
  });

  it('does not retry auth errors but falls back to the next provider', async () => {
    const primary = scripted('gemini', 'gemini-3.5-flash-lite', [new LlmError('auth', 'bad key')]);
    const fallback = scripted('claude', 'claude-haiku-5-5', [
      { answer: 'from claude', confidence: 1 },
    ]);
    const events: LlmCallEvent[] = [];
    const client = createLlmClient({
      providers: [primary, fallback],
      onCall: (e) => events.push(e),
      sleep: noSleep,
    });

    const result = await client.generate(request);

    expect(primary.seen).toHaveLength(1);
    expect(result).toMatchObject({ provider: 'claude', fallbackUsed: true });
    expect(events.map((e) => [e.provider, e.ok, e.fallbackUsed])).toEqual([
      ['gemini', false, false],
      ['claude', true, true],
    ]);
  });

  it('reports every provider when the whole chain fails', async () => {
    const client = createLlmClient({
      providers: [
        scripted('gemini', 'g', [new LlmError('model_not_found', 'gone')]),
        scripted('ollama', 'llama', [new LlmError('network', 'refused')]),
      ],
      sleep: noSleep,
      maxRetries: 0,
    });
    const err = await client.generate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toContain('gemini/g: model_not_found');
    expect((err as LlmError).message).toContain('ollama/llama: network');
  });

  it('does not fall back when the caller aborts', async () => {
    const controller = new AbortController();
    const hanging: ProviderAdapter = {
      provider: 'gemini',
      model: 'g',
      complete: (req) =>
        new Promise((_, reject) =>
          req.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
        ),
    };
    const fallback = scripted('mock', 'demo', [{ answer: 'no', confidence: 0 }]);
    const client = createLlmClient({ providers: [hanging, fallback], sleep: noSleep });

    const pending = client.generate({ ...request, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(fallback.seen).toHaveLength(0);
  });

  it('turns a slow provider into a timeout error', async () => {
    const hanging: ProviderAdapter = {
      provider: 'ollama',
      model: 'slow',
      complete: (req) =>
        new Promise((_, reject) =>
          req.signal.addEventListener('abort', () => reject(req.signal.reason)),
        ),
    };
    const client = createLlmClient({
      providers: [hanging],
      timeoutMs: 20,
      maxRetries: 0,
      sleep: noSleep,
    });
    await expect(client.generate(request)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('serves repeated requests with the same cacheKey from memory', async () => {
    const adapter = scripted('mock', 'demo', [{ answer: 'once', confidence: 1 }]);
    const events: LlmCallEvent[] = [];
    const client = createLlmClient({
      providers: [adapter],
      onCall: (e) => events.push(e),
      sleep: noSleep,
    });

    await client.generate({ ...request, cacheKey: 'page-hash-1' });
    const second = await client.generate({ ...request, cacheKey: 'page-hash-1' });

    expect(adapter.seen).toHaveLength(1);
    expect(second).toMatchObject({ cacheHit: true, data: { answer: 'once' } });
    expect(second.usage.costUsd).toBe(0);
    expect(events.map((e) => e.cacheHit)).toEqual([false, true]);
  });

  it('uses the price override and reports null cost for unknown models', async () => {
    const known = createLlmClient({
      providers: [scripted('openai', 'some-model', [{ answer: 'a', confidence: 1 }])],
      priceOverride: { input: 1, output: 2 },
      sleep: noSleep,
    });
    expect((await known.generate(request)).usage.costUsd).toBeCloseTo((100 + 40) / 1e6, 12);

    const unknown = createLlmClient({
      providers: [scripted('openai', 'some-model', [{ answer: 'a', confidence: 1 }])],
      sleep: noSleep,
    });
    expect((await unknown.generate(request)).usage.costUsd).toBeNull();
  });
});

describe('healthCheck', () => {
  it('reports ok for a working provider', async () => {
    const client = createLlmClient({
      providers: [new MockAdapter(() => ({ ok: true }))],
      sleep: noSleep,
    });
    expect(await client.healthCheck()).toMatchObject({ ok: true, provider: 'mock' });
  });

  it('explains a retired Gemini model with an actionable hint and no retries', async () => {
    const adapter = scripted('gemini', 'gemini-2.5-flash', [
      new LlmError('model_not_found', '404 model not found'),
    ]);
    const client = createLlmClient({ providers: [adapter], sleep: noSleep });

    const status = await client.healthCheck();

    expect(status).toMatchObject({
      ok: false,
      errorKind: 'model_not_found',
      model: 'gemini-2.5-flash',
    });
    expect(status.hint).toContain('deprecations');
    expect(status.hint).toContain('GHOSTIQ_LLM_MODEL');
    expect(adapter.seen).toHaveLength(1);
  });
});

describe('extractJson', () => {
  it('handles fenced and prose-wrapped JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a": [1,2]} Hope that helps.')).toEqual({ a: [1, 2] });
  });

  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow(SyntaxError);
  });
});
