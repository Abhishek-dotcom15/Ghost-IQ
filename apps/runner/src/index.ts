#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { io, type Socket } from 'socket.io-client';
import { RunCancelCommand, RunTestCommand, SocketEvents } from '@ghostiq/shared';
import { executeRun, type RunnerOptions } from './run.js';

const program = new Command();

program
  .name('ghostiq-agent')
  .description('GhostIQ runner agent: drives a local browser for the GhostIQ control plane')
  .version('0.7.0')
  .requiredOption(
    '-k, --key <key>',
    'Project ID to register against',
    process.env.GHOSTIQ_PROJECT_ID,
  )
  .option(
    '-u, --url <url>',
    'GhostIQ server URL',
    process.env.GHOSTIQ_SERVER_URL ?? 'http://localhost:3001',
  )
  .option('--headed', 'Show the browser window', false)
  .option('--no-trace', 'Do not record Playwright traces')
  .option(
    '--storage-state <file>',
    'Playwright storageState JSON to start logged in (skips spending LLM calls on login)',
    process.env.GHOSTIQ_STORAGE_STATE,
  )
  .action(
    (options: {
      key: string;
      url: string;
      headed: boolean;
      trace: boolean;
      storageState?: string;
    }) => {
      startAgent(options.key, {
        serverUrl: options.url.replace(/\/+$/, ''),
        headless: !options.headed,
        trace: options.trace,
        storageStatePath: options.storageState,
      });
    },
  );

program.parse(process.argv);

function startAgent(projectId: string, runnerOptions: RunnerOptions) {
  console.log('\n👻 GhostIQ runner agent');
  console.log(`   server : ${runnerOptions.serverUrl}`);
  console.log(`   project: ${projectId}`);
  if (runnerOptions.storageStatePath) console.log(`   login  : ${runnerOptions.storageStatePath}`);
  console.log('');

  const socket: Socket = io(runnerOptions.serverUrl, {
    query: { role: 'agent', projectId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30_000,
  });

  const runs = new Map<string, AbortController>();

  socket.on('connect', () => console.log('🟢 Connected. Waiting for runs from the dashboard...'));
  socket.on('disconnect', (reason) => console.log(`🔴 Disconnected (${reason}). Reconnecting...`));
  socket.on('connect_error', (err) =>
    console.log(`⚠️  Connection error: ${err.message}. Retrying...`),
  );

  socket.on(SocketEvents.runStart, async (raw: unknown) => {
    const command = RunTestCommand.safeParse(raw);
    if (!command.success) {
      console.error('Ignoring invalid run command:', command.error.issues);
      return;
    }
    const controller = new AbortController();
    runs.set(command.data.sessionId, controller);
    try {
      await executeRun(command.data, socket, runnerOptions, controller.signal);
    } finally {
      runs.delete(command.data.sessionId);
    }
  });

  socket.on(SocketEvents.runCancel, (raw: unknown) => {
    const command = RunCancelCommand.safeParse(raw);
    if (!command.success) return;
    const controller = runs.get(command.data.sessionId);
    if (controller) {
      console.log(`Cancelling run ${command.data.sessionId}...`);
      controller.abort();
    }
  });

  let stopping = false;
  const exit = () => {
    if (stopping) process.exit(1);
    stopping = true;
    if (runs.size > 0) console.log(`Cancelling ${runs.size} run(s) in progress...`);
    for (const controller of runs.values()) controller.abort();
    // Give cancelled runs a moment to report back before disconnecting.
    setTimeout(
      () => {
        socket.disconnect();
        process.exit(0);
      },
      runs.size > 0 ? 3000 : 0,
    );
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}
