import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PersonaSpec } from '@ghostiq/shared';
import { formatPersonaErrors, parsePersona } from './loader.js';

/** Where the built-in persona YAML files live (works from src/ and dist/). */
export const BUILTIN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'builtin',
);

export interface LoadedPersona {
  persona: PersonaSpec;
  yaml: string;
  source: string;
}

/** Loads every *.yaml/*.yml file in a directory. Invalid files throw with line numbers. */
export function loadPersonaDir(dir: string): LoadedPersona[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((file) => {
      const source = path.join(dir, file);
      const yaml = fs.readFileSync(source, 'utf8');
      const result = parsePersona(yaml);
      if (!result.ok)
        throw new Error(`Invalid persona file:\n${formatPersonaErrors(result.errors, source)}`);
      return { persona: result.persona, yaml, source };
    });
}

let cached: LoadedPersona[] | undefined;

/** The personas that ship with GhostIQ. */
export function loadBuiltinPersonas(): LoadedPersona[] {
  cached ??= loadPersonaDir(BUILTIN_DIR);
  return cached;
}
