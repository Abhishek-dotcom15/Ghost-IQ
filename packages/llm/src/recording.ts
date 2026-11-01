import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LlmError } from './errors.js';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from './types.js';

export type RecordMode = 'record' | 'replay';

interface Fixture {
  provider: string;
  model: string;
  purpose: string;
  request: { system: string; user: string };
  response: AdapterResponse;
}

/**
 * VCR-style wrapper. `record` calls the real provider and saves each exchange;
 * `replay` answers from saved fixtures and never touches the network, so CI can
 * run real-model transcripts deterministically and for free.
 */
export function withRecording(
  adapter: ProviderAdapter,
  options: { mode: RecordMode; dir: string },
): ProviderAdapter {
  return {
    provider: adapter.provider,
    model: adapter.model,
    async complete(request: AdapterRequest): Promise<AdapterResponse> {
      const key = fixtureKey(adapter, request);
      const file = path.join(options.dir, `${safe(request.purpose)}-${key}.json`);

      if (options.mode === 'replay') {
        let raw: string;
        try {
          raw = await fs.promises.readFile(file, 'utf8');
        } catch {
          throw new LlmError(
            'fixture_missing',
            `No recorded fixture for "${request.purpose}" (${key}). Re-record with GHOSTIQ_LLM_RECORD_MODE=record.`,
            { provider: adapter.provider, model: adapter.model },
          );
        }
        return (JSON.parse(raw) as Fixture).response;
      }

      const response = await adapter.complete(request);
      const fixture: Fixture = {
        provider: adapter.provider,
        model: adapter.model,
        purpose: request.purpose,
        request: { system: request.system, user: request.user },
        response,
      };
      await fs.promises.mkdir(options.dir, { recursive: true });
      await fs.promises.writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
      return response;
    },
  };
}

/** Stable across runs: depends only on what is sent to the provider. */
export function fixtureKey(adapter: ProviderAdapter, request: AdapterRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        adapter.provider,
        adapter.model,
        request.purpose,
        request.system,
        request.user,
        request.jsonSchema,
      ]),
    )
    .digest('hex')
    .slice(0, 24);
}

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}
