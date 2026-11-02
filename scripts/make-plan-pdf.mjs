#!/usr/bin/env node
// Renders a Markdown doc to PDF with the Playwright Chromium the runner already uses.
//   node scripts/make-plan-pdf.mjs [docs/IMPLEMENTATION_PLAN.md] [docs/GhostIQ_Implementation_Plan.pdf]
// Supports the Markdown used in our docs: headings, paragraphs, lists (incl. task lists),
// tables, fenced code, inline code, bold, italics and links.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = path.resolve(root, process.argv[2] ?? 'docs/IMPLEMENTATION_PLAN.md');
const output = path.resolve(root, process.argv[3] ?? 'docs/GhostIQ_Implementation_Plan.pdf');
const { chromium } = createRequire(path.join(root, 'apps/runner/package.json'))('playwright');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(text) {
  const codes = [];
  // Protect inline code from the bold/italic/link rules with @@CODEn@@ placeholders.
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `@@CODE${codes.push(c) - 1}@@`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return s.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function render(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  const slug = (t) =>
    t
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '');
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      html.push(`<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\|/.test(line) && /^\|\s*-/.test(lines[i + 1] ?? '')) {
      const cells = (l) =>
        l
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (
        i < lines.length &&
        (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))
      ) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i]))
          items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        `<${tag}>${items
          .map((it) => {
            const task = it.match(/^\[( |x)\]\s+(.*)$/i);
            return task
              ? `<li class="task"><span class="box">${task[1].trim() ? '☑' : '☐'}</span> ${inline(task[2])}</li>`
              : `<li>${inline(it)}</li>`;
          })
          .join('')}</${tag}>`,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\||\s*([-*]|\d+\.)\s)/.test(lines[i])
    )
      para.push(lines[i++]);
    html.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return html.join('\n');
}

const md = fs.readFileSync(input, 'utf8');
const title = md.match(/^#\s+(.*)$/m)?.[1] ?? 'GhostIQ';
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  body { font-family: 'Segoe UI', Inter, system-ui, sans-serif; font-size: 10.2pt; line-height: 1.5; color: #1b1d29; }
  h1 { font-size: 22pt; color: #3b2fd1; border-bottom: 3px solid #6d5efc; padding-bottom: 6px; margin: 0 0 10px; }
  h2 { font-size: 14.5pt; color: #2a2370; margin: 20px 0 6px; padding-top: 6px; border-top: 1px solid #e3e1f5; page-break-after: avoid; }
  h3 { font-size: 11.5pt; color: #3b2fd1; margin: 14px 0 4px; page-break-after: avoid; }
  h4 { font-size: 10.5pt; margin: 10px 0 4px; }
  p { margin: 5px 0; }
  ul, ol { margin: 4px 0 6px 18px; padding: 0; }
  li { margin: 2px 0; }
  li.task { list-style: none; margin-left: -16px; }
  .box { font-size: 11pt; color: #3b2fd1; }
  code { font-family: Consolas, 'Fira Code', monospace; font-size: 8.8pt; background: #f1f0fb; padding: 0 3px; border-radius: 3px; }
  pre { background: #12141c; color: #d8e3ff; padding: 9px 11px; border-radius: 6px; font-size: 8.3pt; line-height: 1.4; white-space: pre-wrap; page-break-inside: avoid; }
  pre code { background: none; color: inherit; padding: 0; font-size: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 9pt; page-break-inside: avoid; }
  th { background: #efedfd; color: #2a2370; text-align: left; }
  th, td { border: 1px solid #dcd9f2; padding: 4px 6px; vertical-align: top; }
  strong { color: #11121a; }
  a { color: #3b2fd1; text-decoration: none; }
</style></head><body>${render(md)}</body></html>`;

const browser = await chromium.launch();
const tab = await browser.newPage();
await tab.setContent(page, { waitUntil: 'load' });
// --preview <png>: also save a screenshot of the rendered document (for checking the layout).
const previewAt = process.argv.indexOf('--preview');
if (previewAt > 0) {
  await tab.setViewportSize({ width: 794, height: 1123 });
  await tab.screenshot({ path: process.argv[previewAt + 1], fullPage: true });
}
await tab.pdf({
  path: output,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#888;font-family:Segoe UI,sans-serif">${esc(title.replace(/ — .*$/, ''))} · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
  margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
});
await browser.close();
console.log(
  `Wrote ${path.relative(root, output)} (${Math.round(fs.statSync(output).size / 1024)} KB)`,
);
