#!/usr/bin/env node
// Checks links in the repository's Markdown files and workflow/action references.
//   node scripts/check-links.mjs              relative links + #anchors (offline, used in verify)
//   node scripts/check-links.mjs --external   also requests every http(s) URL
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const external = process.argv.includes('--external');
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'evals',
  'public',
  'data',
  'test-results',
  'generated',
  'ghostiq-report',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(md|ya?ml)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

/** GitHub-style heading slugs. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsOf(file) {
  const seen = new Map();
  const anchors = new Set();
  let inCode = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n ? `${base}-${n}` : base);
  }
  return anchors;
}

const problems = [];
const urls = new Map(); // url -> [where]

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const text = fs.readFileSync(file, 'utf8');
  if (/\.md$/i.test(file)) {
    // Strip fenced code blocks: links inside them are examples.
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^https?:\/\//.test(target)) {
        urls.set(target, [...(urls.get(target) ?? []), rel]);
        continue;
      }
      if (/^(mailto:|tel:)/.test(target)) continue;
      const [p, anchor] = target.split('#');
      const dest = p ? path.resolve(path.dirname(file), decodeURIComponent(p)) : file;
      if (!fs.existsSync(dest)) {
        problems.push(`${rel}: broken link ${target}`);
        continue;
      }
      if (anchor && /\.md$/i.test(dest) && !anchorsOf(dest).has(anchor.toLowerCase())) {
        problems.push(`${rel}: missing anchor #${anchor} in ${path.relative(root, dest)}`);
      }
    }
    for (const m of prose.matchAll(/<(https?:\/\/[^>\s]+)>/g)) {
      urls.set(m[1], [...(urls.get(m[1]) ?? []), rel]);
    }
  } else {
    // Workflows and action.yml: `uses: owner/repo@ref` must exist on GitHub.
    const code = text.replace(/^\s*#.*$/gm, '');
    for (const m of code.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([\w.-]+)/g)) {
      urls.set(`https://github.com/${m[1]}/tree/${m[2]}`, [
        ...(urls.get(`https://github.com/${m[1]}/tree/${m[2]}`) ?? []),
        rel,
      ]);
    }
  }
}

if (external) {
  const entries = [...urls];
  const results = await Promise.all(
    entries.map(async ([url]) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'user-agent': 'ghostiq-link-check' },
            signal: AbortSignal.timeout(20_000),
          });
          if (res.status < 400 || res.status === 429) return [url, res.status];
          if (attempt === 1) return [url, res.status];
        } catch (err) {
          if (attempt === 1) return [url, err.message];
        }
      }
      return [url, 'unknown'];
    }),
  );
  for (const [url, status] of results) {
    const ok = typeof status === 'number' && (status < 400 || status === 429);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${status} ${url}`);
    if (!ok) problems.push(`${urls.get(url).join(', ')}: ${url} -> ${status}`);
  }
}

console.log(
  `\nChecked ${walk(root).length} files, ${urls.size} external URL(s)${external ? '' : ' (not requested; use --external)'}.`,
);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('No broken links.');
