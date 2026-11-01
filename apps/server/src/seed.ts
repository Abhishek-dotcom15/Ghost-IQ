import { createPrismaClient } from './db.js';
import { loadEnv } from './env.js';

/** Fixed ID so the runner quick start works without copying a UUID. */
export const DEMO_PROJECT_ID = 'local-app-test-project-id';

const env = loadEnv();
const prisma = createPrismaClient(env.DATABASE_URL);

try {
  const existing = await prisma.project.findUnique({ where: { id: DEMO_PROJECT_ID } });
  if (existing) {
    console.log(`Demo project already exists (${DEMO_PROJECT_ID})`);
  } else {
    const project = await prisma.project.create({
      data: { id: DEMO_PROJECT_ID, name: 'GhostIQ Local App Test' },
    });
    console.log(`Created demo project "${project.name}" (${project.id})`);
  }
} catch (err) {
  console.error('Seeding failed:', err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
