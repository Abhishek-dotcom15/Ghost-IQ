#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { io, type Socket } from 'socket.io-client';
import { RunTestCommand, SocketEvents } from '@ghostiq/shared';
import { PlaywrightRunner } from './runner.js';

const program = new Command();

program
  .name('ghostiq-agent')
  .description('GhostIQ runner agent: drives a local browser for the GhostIQ control plane')
  .version('0.2.0')
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
  .action((options: { key: string; url: string }) => {
    startAgent(options.key, options.url);
  });

program.parse(process.argv);

function startAgent(projectId: string, serverUrl: string) {
  console.log('\n👻 GhostIQ runner agent');
  console.log(`   server : ${serverUrl}`);
  console.log(`   project: ${projectId}\n`);

  const socket: Socket = io(serverUrl, {
    query: { role: 'agent', projectId },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30_000,
  });

  const runner = new PlaywrightRunner(socket, serverUrl);
  let activeRuns = 0;

  socket.on('connect', () => {
    console.log('🟢 Connected. Waiting for runs from the dashboard...');
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔴 Disconnected (${reason}). Reconnecting...`);
  });

  socket.on('connect_error', (err) => {
    console.log(`⚠️  Connection error: ${err.message}. Retrying...`);
  });

  socket.on(SocketEvents.runTest, async (raw: unknown) => {
    const command = RunTestCommand.safeParse(raw);
    if (!command.success) {
      console.error('Ignoring invalid run command:', command.error.issues);
      return;
    }
    activeRuns++;
    try {
      await runner.runSession(command.data);
    } catch (err) {
      console.error('Fatal error in runner:', err);
    } finally {
      activeRuns--;
    }
  });

  const exit = () => {
    if (activeRuns > 0) console.log(`Stopping with ${activeRuns} run(s) in progress.`);
    socket.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}
