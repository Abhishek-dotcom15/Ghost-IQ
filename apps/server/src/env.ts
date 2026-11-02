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
  /** Run artifacts such as Playwright traces. */
  GHOSTIQ_ARTIFACT_DIR: z.string().default('public/artifacts'),
  /** Optional folder of persona YAML files, loaded at boot alongside the built-ins. */
  GHOSTIQ_PERSONAS_DIR: optional(z.string()),
  /** Notified when a run finishes (JSON, or a Slack message for hooks.slack.com URLs). */
  GHOSTIQ_WEBHOOK_URL: optional(z.url()),
  /** Only notify for runs with findings at or above this severity (default: every run). */
  GHOSTIQ_WEBHOOK_MIN_SEVERITY: optional(z.enum(['critical', 'high', 'medium', 'low', 'info'])),
  /** Public dashboard URL used in notifications, e.g. https://ghostiq.example.com */
  GHOSTIQ_PUBLIC_URL: optional(z.url()),

  // ---- Security (docs/SECURITY.md)
  /** on: every API call needs a login, API key or admin token. Default: on in production. */
  GHOSTIQ_AUTH: optional(z.enum(['on', 'off'])),
  /** Bootstrap admin login (and break-glass access). At least 24 characters. */
  GHOSTIQ_ADMIN_TOKEN: optional(
    z.string().min(24, 'GHOSTIQ_ADMIN_TOKEN must be at least 24 characters'),
  ),
  GITHUB_CLIENT_ID: optional(z.string()),
  GITHUB_CLIENT_SECRET: optional(z.string()),
  /** GitHub logins allowed to sign in (comma-separated), or "*" for anyone. */
  GHOSTIQ_GITHUB_ALLOWED_USERS: optional(z.string()),
  /** Overrides for GitHub Enterprise and tests. */
  GHOSTIQ_GITHUB_OAUTH_URL: z.url().default('https://github.com'),
  GHOSTIQ_GITHUB_API_URL: z.url().default('https://api.github.com'),
  GHOSTIQ_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .default(24 * 7),
  /** Hosted mode: refuse run targets and webhooks on private/internal addresses (SSRF guard). */
  GHOSTIQ_HOSTED: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** Hosts allowed even when they resolve to private addresses (e.g. the demo app's service name). */
  GHOSTIQ_ALLOWED_TARGETS: optional(z.string()),
  /** Default: on when sign-in is on (shared server), off for a local single-user install. */
  GHOSTIQ_RATE_LIMIT: optional(z.enum(['on', 'off'])),
  /** Number of reverse proxies in front of the server (sets Express "trust proxy" for client IPs). */
  GHOSTIQ_TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Delete runs older than this many days (baselines and evidence still used by findings are kept). */
  GHOSTIQ_RETENTION_DAYS: optional(z.coerce.number().int().min(1)),

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
  const env = parsed.data;
  if (authEnabled(env) && !env.GHOSTIQ_ADMIN_TOKEN && !githubConfigured(env)) {
    throw new Error(
      'Authentication is on (GHOSTIQ_AUTH=on, the default in production) but no way to sign in is configured. ' +
        'Set GHOSTIQ_ADMIN_TOKEN (24+ characters) and/or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET, ' +
        'or set GHOSTIQ_AUTH=off for a private, single-user install.',
    );
  }
  if (githubConfigured(env) && !env.GHOSTIQ_GITHUB_ALLOWED_USERS) {
    throw new Error(
      'GitHub sign-in is configured without GHOSTIQ_GITHUB_ALLOWED_USERS. List the allowed GitHub logins (comma-separated), or "*" to allow anyone.',
    );
  }
  return env;
}

export function authEnabled(env: Env): boolean {
  return (env.GHOSTIQ_AUTH ?? (env.NODE_ENV === 'production' ? 'on' : 'off')) === 'on';
}

export function rateLimitEnabled(env: Env): boolean {
  return (env.GHOSTIQ_RATE_LIMIT ?? (authEnabled(env) ? 'on' : 'off')) === 'on';
}

export function githubConfigured(env: Env): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}
