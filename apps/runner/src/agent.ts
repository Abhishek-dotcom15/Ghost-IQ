import { io, type Socket } from 'socket.io-client';
import { RunCancelCommand, RunTestCommand, SocketEvents } from '@ghostiq/shared';
import { executeRun, type RunnerOptions } from './run.js';

export interface AgentHandle {
  socket: Socket;
  /** Resolves once connected to the server. */
  connected: Promise<void>;
  /** Runs in progress on this agent. */
  activeRuns(): number;
  /** Cancels running runs, waits briefly for them to report, then disconnects. */
  stop(graceMs?: number): Promise<void>;
}

/**
 * Connects to the control plane as the runner for one project and executes the runs it
 * is sent. Used by the `ghostiq-agent` binary and embedded by `ghostiq run`.
 */
export function startAgent(
  projectId: string,
  runnerOptions: RunnerOptions,
  log: (msg: string) => void = console.log,
): AgentHandle {
  const socket: Socket = io(runnerOptions.serverUrl, {
    query: { role: 'agent', projectId },
    auth: runnerOptions.apiKey ? { token: runnerOptions.apiKey } : {},
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30_000,
  });
  const runs = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

  const connected = new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  socket.on('connect', () => log('Runner connected. Waiting for runs...'));
  socket.on('disconnect', (reason) => log(`Runner disconnected (${reason}). Reconnecting...`));
  socket.on('connect_error', (err) => {
    if (/Unauthorized/.test(err.message)) {
      log(
        `Runner refused: ${err.message}. Create a key under Project settings > API keys and pass it with --api-key (or GHOSTIQ_API_KEY).`,
      );
    } else {
      log(`Runner connection error: ${err.message}. Retrying...`);
    }
  });

  socket.on(SocketEvents.runStart, (raw: unknown) => {
    const command = RunTestCommand.safeParse(raw);
    if (!command.success) {
      log(`Ignoring invalid run command: ${JSON.stringify(command.error.issues).slice(0, 500)}`);
      return;
    }
    const controller = new AbortController();
    const done = executeRun(command.data, socket, runnerOptions, controller.signal).finally(() =>
      runs.delete(command.data.sessionId),
    );
    runs.set(command.data.sessionId, { controller, done });
  });

  socket.on(SocketEvents.runCancel, (raw: unknown) => {
    const command = RunCancelCommand.safeParse(raw);
    if (!command.success) return;
    const run = runs.get(command.data.sessionId);
    if (run) {
      log(`Cancelling run ${command.data.sessionId}...`);
      run.controller.abort();
    }
  });

  return {
    socket,
    connected,
    activeRuns: () => runs.size,
    async stop(graceMs = 3000) {
      const pending = [...runs.values()];
      for (const run of pending) run.controller.abort();
      if (pending.length) {
        await Promise.race([
          Promise.allSettled(pending.map((r) => r.done)),
          new Promise((r) => setTimeout(r, graceMs)),
        ]);
      }
      socket.disconnect();
    },
  };
}
