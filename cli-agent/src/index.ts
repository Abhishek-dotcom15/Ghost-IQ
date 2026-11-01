#!/usr/bin/env ts-node
import { Command } from 'commander';
import { io, Socket } from 'socket.io-client';
import { PlaywrightRunner } from './runner';
import dotenv from 'dotenv';

dotenv.config();

const program = new Command();

program
  .name('ghostiq-agent')
  .description('GhostIQ Local Testing WebSocket Runner Agent')
  .version('1.0.0')
  .requiredOption('-k, --key <key>', 'Unique Project ID to register agent against')
  .option('-u, --url <url>', 'Central GhostIQ server WebSocket URL', 'http://localhost:3001')
  .action((options) => {
    const { key, url } = options;
    startAgent(key, url);
  });

program.parse(process.argv);

function startAgent(projectId: string, serverUrl: string) {
  console.log(`
┌────────────────────────────────────────────────────────┐
│   👻  G H O S T I Q   L O C A L   Q A   A G E N T      │
│   Mimics user actions & runs test sessions locally      │
└────────────────────────────────────────────────────────┘
  `);
  
  console.log(`🔌 Connecting to GhostIQ Server: ${serverUrl}`);
  console.log(`🔑 Registering Project ID Key: ${projectId}\n`);

  const socket: Socket = io(serverUrl, {
    query: {
      role: 'agent',
      projectId: projectId
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000
  });

  const runner = new PlaywrightRunner(socket, serverUrl);

  socket.on('connect', () => {
    console.log('🟢 Successfully connected to GhostIQ Central Server!');
    console.log('📡 Waiting for test session triggers from Dashboard...\n');
  });

  socket.on('disconnect', (reason) => {
    console.log(`🔴 Disconnected from server (Reason: ${reason}). Attempting to reconnect...`);
  });

  socket.on('connect_error', (err) => {
    console.log(`⚠️ Connection error: ${err.message}. Retrying...`);
  });

  // Listener to execute tests streamed from the central server
  socket.on('run-test', async (data: { sessionId: string; targetUrl: string; persona: string; goal: string }) => {
    try {
      await runner.runSession(data);
    } catch (err) {
      console.error('Fatal execution error in Playwright runner:', err);
    }
  });

  // Cleanup on process termination
  const cleanExit = () => {
    console.log('\n🔌 Closing WebSocket client connection. Goodbye!');
    socket.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);
}
