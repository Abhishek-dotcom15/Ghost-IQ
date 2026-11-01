import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a fresh SQLite database with the current schema for the test run. */
export default function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-db-'));
  const url = `file:${path.join(dir, 'test.db').replaceAll('\\', '/')}`;
  process.env.TEST_DATABASE_URL = url;

  execFileSync(process.execPath, [prismaCli(), 'db', 'push'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  return () => fs.rmSync(dir, { recursive: true, force: true });
}

function prismaCli(): string {
  return path.resolve('node_modules/prisma/build/index.js');
}
