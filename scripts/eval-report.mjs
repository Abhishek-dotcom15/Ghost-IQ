#!/usr/bin/env node
// Renders benchmark result files (evals/results/*.json, common format from scripts/lib/eval.mjs)
// into the tables in docs/EVALUATION.md, between marker comments such as
//   <!-- eval:B1:start --> ... <!-- eval:B1:end -->
// so published numbers are never typed by hand.
//
//   node scripts/eval-report.mjs            update docs/EVALUATION.md
//   node scripts/eval-report.mjs --check    exit 1 if the doc is out of date (no changes made)
//   node scripts/eval-report.mjs --print    print the generated sections instead of writing
//
// For each benchmark it keeps the latest result per configuration (model + parameters), so
// re-running a benchmark replaces its row instead of adding a new one. Sections with no result
// files are left untouched.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { root } from './lib/stack.mjs';
import { readResults, renderSections, replaceSection } from './lib/eval.mjs';

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    print: { type: 'boolean', default: false },
    dir: { type: 'string', default: path.join(root, 'evals', 'results') },
    doc: { type: 'string', default: path.join(root, 'docs', 'EVALUATION.md') },
  },
});

const results = readResults(args.dir);
const sections = renderSections(results);
if (!Object.keys(sections).length) {
  console.log(`No result files in ${path.relative(root, args.dir)}; nothing to render.`);
  process.exit(0);
}

if (args.print) {
  for (const [name, body] of Object.entries(sections)) console.log(`## ${name}\n\n${body}\n`);
  process.exit(0);
}

const before = fs.readFileSync(args.doc, 'utf8');
let after = before;
for (const [name, body] of Object.entries(sections)) after = replaceSection(after, name, body);

if (args.check) {
  if (after !== before) {
    console.error(
      `${path.relative(root, args.doc)} is out of date: run node scripts/eval-report.mjs`,
    );
    process.exit(1);
  }
  console.log(`${path.relative(root, args.doc)} is up to date.`);
} else if (after === before) {
  console.log(`${path.relative(root, args.doc)} already up to date.`);
} else {
  fs.writeFileSync(args.doc, after);
  console.log(
    `Updated ${Object.keys(sections).join(', ')} in ${path.relative(root, args.doc)} from ${results.length} result file(s).`,
  );
}
