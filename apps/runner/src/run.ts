import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent, type RunOutcome } from '@ghostiq/core';
import { SocketEvents, type RunTestCommand } from '@ghostiq/shared';
import type { Socket } from 'socket.io-client';
import { PlaywrightDriver } from './driver.js';
import { HttpPlanner } from './planner.js';

export interface RunnerOptions {
  serverUrl: string;
  headless: boolean;
  trace: boolean;
  storageStatePath?: string;
}

/** Executes one run end to end: browser, agent loop, events, trace upload. */
export async function executeRun(
  command: RunTestCommand,
  socket: Socket,
  options: RunnerOptions,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const log = (msg: string) => console.log(`[${command.sessionId.slice(0, 8)}] ${msg}`);
  log(`start: ${command.persona} -> ${command.targetUrl} | goal: ${command.goal}`);

  let driver: PlaywrightDriver | undefined;
  let outcome: RunOutcome;
  try {
    driver = await PlaywrightDriver.launch({
      allowedOrigins: command.config.allowedOrigins,
      headless: options.headless,
      trace: options.trace,
      storageStatePath: options.storageStatePath,
    });
    outcome = await runAgent({
      command,
      driver,
      planner: new HttpPlanner(options.serverUrl),
      signal,
      events: {
        stepStarted: (event) => {
          log(`step ${event.stepNumber}: ${event.action} ${event.description}`);
          socket.emit(SocketEvents.stepStarted, event);
        },
        stepCompleted: (event) => {
          const issues = event.issues.length ? ` (${event.issues.length} issue(s))` : '';
          log(
            `step ${event.stepNumber}: ${event.status}${event.error ? ` - ${event.error}` : ''}${issues}`,
          );
          socket.emit(SocketEvents.stepCompleted, event);
        },
      },
    });
  } catch (err) {
    outcome = {
      status: 'FAILED',
      endReason: 'runner_error',
      summary: `Runner error: ${(err as Error).message.split('\n')[0]}`,
      stats: { steps: 0, tokens: 0, durationMs: 0, issues: 0 },
    };
  }

  log(`finished: ${outcome.status} (${outcome.endReason}) - ${outcome.summary}`);
  socket.emit(SocketEvents.sessionCompleted, { sessionId: command.sessionId, ...outcome });

  if (driver) {
    await uploadTrace(driver, command.sessionId, options.serverUrl, log);
    await driver.close();
  }
  return outcome;
}

async function uploadTrace(
  driver: PlaywrightDriver,
  sessionId: string,
  serverUrl: string,
  log: (m: string) => void,
) {
  const file = path.join(os.tmpdir(), `ghostiq-trace-${sessionId}.zip`);
  try {
    if (!(await driver.saveTrace(file))) return;
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/trace`, {
      method: 'PUT',
      headers: { 'content-type': 'application/zip' },
      body: await fs.promises.readFile(file),
    });
    if (res.ok) log('trace uploaded');
    else log(`trace upload failed: HTTP ${res.status}`);
  } catch (err) {
    log(`trace upload failed: ${(err as Error).message}`);
  } finally {
    await fs.promises.rm(file, { force: true });
  }
}
