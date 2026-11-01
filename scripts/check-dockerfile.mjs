#!/usr/bin/env node
// Fails when a workspace package's manifest is not copied in the Dockerfile's install
// layer: the image's frozen-lockfile install would then break. Run as part of `pnpm verify`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

const missing = [];
for (const group of ['apps', 'packages', 'examples']) {
  const dir = path.join(root, group);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const manifest = `${group}/${name}/package.json`;
    if (!fs.existsSync(path.join(root, manifest))) continue;
    if (!dockerfile.includes(`COPY ${manifest} `)) missing.push(manifest);
  }
}

if (missing.length) {
  console.error(`Dockerfile is missing COPY lines for:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('Dockerfile copies every workspace manifest.');
