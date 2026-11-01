import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Same default as src/env.ts so the CLI and the app agree without a .env file.
    url: process.env.DATABASE_URL ?? 'file:./data/ghostiq.db',
  },
});
