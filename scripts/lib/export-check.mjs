// Runs an exported GhostIQ spec with plain Playwright, outside GhostIQ.
// The spec is written to evals/export-check/<name>/ next to a minimal config; the only
// dependency it can resolve is @playwright/test. Returns { passed, output }.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './stack.mjs';

export function runExportedSpec(name, code) {
  const dir = path.join(root, 'evals', 'export-check', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.spec.ts`), code);
  fs.writeFileSync(
    path.join(dir, 'playwright.config.mjs'),
    `export default { testDir: '.', timeout: 120000, reporter: 'list', use: { headless: true }, outputDir: './test-results' };\n`,
  );
  const cli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'test', '--config', path.join(dir, 'playwright.config.mjs')],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
    },
  );
  return {
    passed: result.status === 0,
    output: `${result.stdout}\n${result.stderr}`,
    file: path.join(dir, `${name}.spec.ts`),
  };
}
