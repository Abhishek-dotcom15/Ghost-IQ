import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LocalServer {
  url: string;
  dataDir: string;
  logFile: string;
  stop(): Promise<void>;
}

/** apps/server next to this runner (monorepo / GitHub Action checkout), or GHOSTIQ_SERVER_DIR. */
export function serverDir(): string {
  const fromEnv = process.env.GHOSTIQ_SERVER_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  // dist/cli/local-server.js -> apps/runner -> apps/server
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a throwaway control plane for one CLI command: fresh SQLite database and artifact
 * folders in a temp dir, a free port, LLM settings from the environment.
 */
export async function startLocalServer(
  options: { dataDir?: string; log?: (m: string) => void } = {},
): Promise<LocalServer> {
  const dir = serverDir();
  const entry = path.join(dir, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(
      `GhostIQ server build not found at ${entry}. Build it (pnpm build) or pass --server <url>.`,
    );
  }
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ghostiq-'));
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'ghostiq.db').replace(/\\/g, '/');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: `file:${dbFile}`,
    GHOSTIQ_SCREENSHOT_DIR: path.join(dataDir, 'screenshots'),
    GHOSTIQ_ARTIFACT_DIR: path.join(dataDir, 'artifacts'),
    NODE_ENV: 'production',
  };

  execFileSync(
    process.execPath,
    [path.join(dir, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push'],
    {
      cwd: dir,
      env,
      stdio: 'pipe',
    },
  );

  const logFile = path.join(dataDir, 'server.log');
  const out = fs.openSync(logFile, 'a');
  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: dir,
    env,
    stdio: ['ignore', out, out],
  });
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`The local GhostIQ server exited (code ${child.exitCode}); see ${logFile}`);
    }
    try {
      if ((await fetch(`${url}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The local GhostIQ server did not start in 30 s; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  options.log?.(`Started a local GhostIQ server on ${url} (data: ${dataDir})`);

  return {
    url,
    dataDir,
    logFile,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      fs.closeSync(out);
    },
  };
}
