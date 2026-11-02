import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEVERITIES } from '@ghostiq/shared';
import { z } from 'zod';

export const REPORT_FORMATS = ['html', 'junit', 'sarif', 'json'] as const;
export const FAIL_ON = [...SEVERITIES, 'none'] as const;

/**
 * `ghostiq.config.{ts,mts,mjs,js,json}`: what `ghostiq run` tests and when it fails.
 * Every field can also be given as a CLI flag (flags win).
 */
export const GhostiqConfig = z.object({
  /** GhostIQ server URL. Omit to start a throwaway local server for this command. */
  server: z.url().optional(),
  /** Project id or name on the server (created if a name does not exist). */
  project: z.string().min(1).max(200).default('ghostiq-ci'),
  /** The app under test. */
  target: z.url(),
  /** Persona ids, run one after another. */
  personas: z.array(z.string().min(1)).min(1).max(20).default(['happy-path']),
  /** Goal for every persona (defaults to each persona's own first goal). */
  goal: z.string().max(2000).optional(),
  seed: z.number().int().min(0).optional(),
  budgets: z
    .object({
      maxSteps: z.number().int().min(1).max(200),
      maxDurationMs: z.number().int().min(10_000),
      maxTokens: z.number().int().min(1000),
    })
    .partial()
    .optional(),
  allowedOrigins: z.array(z.string()).max(19).optional(),
  allowDestructive: z.boolean().optional(),
  /** Required for personas marked requires_consent (security prober). */
  consent: z.boolean().default(false),
  /** Fail (exit 1) when a finding at or above this severity occurred. `none` never fails. */
  failOn: z.enum(FAIL_ON).default('high'),
  /** Only count findings first seen in this command's runs (useful with a long-lived server). */
  newOnly: z.boolean().default(false),
  /** Count heuristic ("suspected") findings towards failOn too. */
  includeSuspected: z.boolean().default(false),
  /** Fail when a persona does not reach its goal. */
  failOnGoal: z.boolean().default(false),
  reports: z
    .object({
      dir: z.string().default('ghostiq-report'),
      formats: z.array(z.enum(REPORT_FORMATS)).default([...REPORT_FORMATS]),
    })
    .prefault({}),
  /** Playwright storageState JSON to start logged in. */
  storageState: z.string().optional(),
  headed: z.boolean().default(false),
});
export type GhostiqConfig = z.infer<typeof GhostiqConfig>;
export type GhostiqConfigInput = z.input<typeof GhostiqConfig>;

/** Typed helper for config files: `export default defineConfig({ ... })`. */
export function defineConfig(config: GhostiqConfigInput): GhostiqConfigInput {
  return config;
}

export const CONFIG_FILES = [
  'ghostiq.config.ts',
  'ghostiq.config.mts',
  'ghostiq.config.mjs',
  'ghostiq.config.js',
  'ghostiq.config.json',
];

export class ConfigError extends Error {}

export function findConfigFile(cwd: string, explicit?: string): string | undefined {
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    if (!fs.existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
    return file;
  }
  return CONFIG_FILES.map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
}

/** Loads a config file. TypeScript configs need Node 22.18+ (built-in type stripping). */
export async function loadConfigFile(file: string): Promise<Record<string, unknown>> {
  try {
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const value = mod.default ?? mod;
    if (typeof value !== 'object' || value === null) {
      throw new ConfigError(`${file} must export a config object (export default { ... }).`);
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Could not load ${file}: ${(err as Error).message}`);
  }
}

/** File config, then flags on top; validated. Throws ConfigError with readable issues. */
export function resolveConfig(
  fileConfig: Record<string, unknown>,
  overrides: Record<string, unknown>,
): GhostiqConfig {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const merged = { ...fileConfig, ...defined };
  if (defined.budgets || fileConfig.budgets) {
    merged.budgets = { ...(fileConfig.budgets as object), ...(defined.budgets as object) };
  }
  if (defined.reports || fileConfig.reports) {
    merged.reports = { ...(fileConfig.reports as object), ...(defined.reports as object) };
  }
  const parsed = GhostiqConfig.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid GhostIQ configuration:\n${issues}`);
  }
  return parsed.data;
}
