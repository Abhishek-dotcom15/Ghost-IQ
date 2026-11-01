import { createApp } from './app.js';
import { createPrismaClient } from './db.js';
import { loadEnv } from './env.js';
import { AiService } from './services/ai.js';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);
const ai = new AiService(env);
const { server, io } = createApp({ env, prisma, ai });

server.listen(env.PORT, () => {
  console.log(`GhostIQ server listening on http://localhost:${env.PORT}`);
  console.log(`LLM: ${ai.describe()}`);
});

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
