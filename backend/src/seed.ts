import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding GhostIQ SQLite Database...');

  // Create a default project with a static, clean UUID for local testing
  const projectId = 'local-app-test-project-id';
  
  const existing = await prisma.project.findUnique({
    where: { id: projectId }
  });

  if (!existing) {
    const project = await prisma.project.create({
      data: {
        id: projectId,
        name: 'GhostIQ Local App Test'
      }
    });
    console.log(`✅ Default Project created: "${project.name}" (ID: ${project.id})`);
  } else {
    console.log(`ℹ️ Default Project already exists (ID: ${projectId})`);
  }
}

main()
  .catch(e => {
    console.error('Failed to seed DB:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
