import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from './db.js';

export interface RetentionResult {
  sessions: number;
  files: number;
  keptFiles: number;
}

/**
 * Deletes runs older than `days` with their steps, network logs, LLM call records,
 * screenshots and traces. Kept: baseline runs, runs still in progress, and every file a
 * finding, heal or baseline image still points to (so evidence never turns into a broken
 * image). Findings themselves are kept: they are the product.
 */
export async function applyRetention(
  prisma: PrismaClient,
  dirs: { screenshots: string; artifacts: string },
  days: number,
  now = new Date(),
): Promise<RetentionResult> {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const old = await prisma.testSession.findMany({
    where: {
      startedAt: { lt: cutoff },
      isBaseline: false,
      status: { notIn: ['RUNNING', 'PENDING'] },
    },
    select: { id: true },
  });
  if (old.length === 0) return { sessions: 0, files: 0, keptFiles: 0 };

  const referenced = await referencedFiles(prisma);
  let files = 0;
  let keptFiles = 0;
  const remove = (publicPath: string, absolute: string) => {
    if (referenced.has(publicPath)) {
      keptFiles++;
      return;
    }
    fs.rmSync(absolute, { force: true });
    files++;
  };

  for (const { id } of old) {
    // Screenshots: <sessionId>_<step>.png
    for (const name of safeReaddir(dirs.screenshots)) {
      if (name.startsWith(`${id}_`))
        remove(`/screenshots/${name}`, path.join(dirs.screenshots, name));
    }
    // Artifacts: <sessionId>/{trace.zip, diff images}
    const dir = path.join(dirs.artifacts, id);
    for (const name of safeReaddir(dir)) remove(`/artifacts/${id}/${name}`, path.join(dir, name));
    if (safeReaddir(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
  }

  const { count } = await prisma.testSession.deleteMany({
    where: { id: { in: old.map((s) => s.id) } },
  });
  return { sessions: count, files, keptFiles };
}

/** Public paths (/screenshots/..., /artifacts/...) still referenced by stored records. */
async function referencedFiles(prisma: PrismaClient): Promise<Set<string>> {
  const refs = new Set<string>();
  const collect = (text: string | null | undefined) => {
    for (const m of (text ?? '').matchAll(/\/(?:screenshots|artifacts)\/[^"'\s)]+/g))
      refs.add(decodeURI(m[0]));
  };
  for (const f of await prisma.finding.findMany({ select: { evidenceJson: true } }))
    collect(f.evidenceJson);
  for (const h of await prisma.healEvent.findMany({
    select: { beforeScreenshot: true, afterScreenshot: true },
  })) {
    collect(h.beforeScreenshot);
    collect(h.afterScreenshot);
  }
  for (const b of await prisma.baselineImage.findMany({ select: { path: true } })) collect(b.path);
  return refs;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Runs retention now and then every `everyMs` (timer does not keep the process alive). */
export function scheduleRetention(
  run: () => Promise<RetentionResult>,
  everyMs = 6 * 60 * 60 * 1000,
): () => void {
  const tick = () =>
    run()
      .then((r) => {
        if (r.sessions) {
          console.log(
            `[retention] deleted ${r.sessions} run(s), ${r.files} file(s); kept ${r.keptFiles} referenced file(s)`,
          );
        }
      })
      .catch((err: unknown) => console.error('[retention] failed:', err));
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
