import fs from 'node:fs';
import path from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.js';

export type { PrismaClient };

/** Creates the Prisma client for a SQLite URL, creating the parent directory if needed. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  if (databaseUrl.startsWith('file:')) {
    const filePath = databaseUrl.slice('file:'.length);
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  return new PrismaClient({ adapter });
}
