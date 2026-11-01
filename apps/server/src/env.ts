import 'dotenv/config';
import { z } from 'zod';

/** Treats unset and empty/whitespace values the same (docker compose passes "" for unset). */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    schema.optional(),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().default('file:./data/ghostiq.db'),
  /** Comma-separated list of browser origins allowed to call the API. */
  GHOSTIQ_CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Directory with the built dashboard; served by the API in production images. */
  GHOSTIQ_DASHBOARD_DIR: optional(z.string()),
  GHOSTIQ_SCREENSHOT_DIR: z.string().default('public/screenshots'),

  // ---- LLM (see packages/llm). Unset provider + no key => demo mode.
  GHOSTIQ_LLM_PROVIDER: optional(z.enum(['gemini', 'claude', 'openai', 'ollama', 'mock'])),
  GHOSTIQ_LLM_MODEL: optional(z.string()),
  GHOSTIQ_LLM_API_KEY: optional(z.string()),
  GHOSTIQ_LLM_BASE_URL: optional(z.url()),
  /** e.g. "claude,mock" or "claude:claude-sonnet-5-5,ollama:llama3.2" */
  GHOSTIQ_LLM_FALLBACK: optional(z.string()),
  GHOSTIQ_LLM_TIMEOUT_MS: optional(z.coerce.number().int().positive()),
  GHOSTIQ_LLM_MAX_RETRIES: optional(z.coerce.number().int().min(0).max(10)),
  GHOSTIQ_LLM_RECORD_MODE: z.enum(['off', 'record', 'replay']).default('off'),
  GHOSTIQ_LLM_FIXTURES_DIR: z.string().default('fixtures/llm'),
  /** USD per 1M tokens; overrides the built-in price table for the primary model. */
  GHOSTIQ_LLM_PRICE_INPUT: optional(z.coerce.number().nonnegative()),
  GHOSTIQ_LLM_PRICE_OUTPUT: optional(z.coerce.number().nonnegative()),
  /** Exit at boot if the LLM health check fails, instead of running degraded. */
  GHOSTIQ_LLM_STRICT: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Provider-native key names, used for fallbacks and as a convenience for the primary.
  GEMINI_API_KEY: optional(z.string()),
  ANTHROPIC_API_KEY: optional(z.string()),
  OPENAI_API_KEY: optional(z.string()),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
