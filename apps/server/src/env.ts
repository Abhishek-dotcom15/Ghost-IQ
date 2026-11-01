import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().default('file:./data/ghostiq.db'),
  /** Comma-separated list of browser origins allowed to call the API. */
  GHOSTIQ_CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Directory with the built dashboard; served by the API in production images. */
  GHOSTIQ_DASHBOARD_DIR: z.string().optional(),
  GHOSTIQ_SCREENSHOT_DIR: z.string().default('public/screenshots'),
  GHOSTIQ_LLM_PROVIDER: z.enum(['gemini', 'mock']).default('gemini'),
  GHOSTIQ_LLM_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GHOSTIQ_LLM_API_KEY: z.string().optional(),
  /** Legacy name from the prototype, still honoured. */
  GEMINI_API_KEY: z.string().optional(),
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
