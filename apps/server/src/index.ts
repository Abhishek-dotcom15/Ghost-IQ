import { createApp } from './app.js';
import { createPrismaClient } from './db.js';
import { loadEnv } from './env.js';
import { createLlmRuntime, describeLlm } from './llm.js';
import { AiService } from './services/ai.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const llm = createLlmRuntime(env, prisma);
const ai = new AiService(llm.client);
const { server, io } = createApp({ env, prisma, ai, llm });

server.listen(env.PORT, () => {
  console.log(`GhostIQ server listening on http://localhost:${env.PORT}`);
  const info = describeLlm(llm);
  if (llm.mode === 'demo') {
    console.warn(`LLM: DEMO MODE (scripted, no AI). ${llm.demoReason ?? ''}`);
  } else {
    console.log(
      `LLM: ${info.provider}/${info.model}${info.fallbacks.length ? ` (fallbacks: ${info.fallbacks.map((f) => `${f.provider}/${f.model}`).join(', ')})` : ''}`,
    );
  }
  void checkLlmHealth();
});

/** One tiny real call at boot so a retired model or bad key is reported immediately. */
async function checkLlmHealth() {
  const health = await llm.client.healthCheck();
  llm.health = health;
  if (health.ok) {
    console.log(`LLM health check passed (${health.latencyMs}ms).`);
    return;
  }
  console.error('\n================ LLM HEALTH CHECK FAILED ================');
  console.error(`${health.provider}/${health.model}: ${health.errorKind}: ${health.message}`);
  if (health.hint) console.error(`Fix: ${health.hint}`);
  console.error('=========================================================\n');
  if (env.GHOSTIQ_LLM_STRICT) process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  await io.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
