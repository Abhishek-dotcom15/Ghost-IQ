#!/usr/bin/env node
// `ghostiq-agent`: a long-running runner for one project. Same as `ghostiq agent`.
import 'dotenv/config';
import { Command } from 'commander';
import { startAgent } from './agent.js';
import { VERSION } from './version.js';

const program = new Command();

program
  .name('ghostiq-agent')
  .description('GhostIQ runner agent: drives a local browser for the GhostIQ control plane')
  .version(VERSION)
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
  .option(
    '--api-key <key>',
    'Project API key (needed when the server has sign-in on)',
    process.env.GHOSTIQ_API_KEY,
  )
  .option('--headed', 'Show the browser window', false)
  .option('--no-trace', 'Do not record Playwright traces')
  .option(
    '--storage-state <file>',
    'Playwright storageState JSON to start logged in (skips spending LLM calls on login)',
    process.env.GHOSTIQ_STORAGE_STATE,
  )
  .action(runAgentCommand);

program.parse(process.argv);

function runAgentCommand(options: {
  key: string;
  url: string;
  headed: boolean;
  trace: boolean;
  storageState?: string;
  apiKey?: string;
}) {
  const serverUrl = options.url.replace(/\/+$/, '');
  console.log('\nGhostIQ runner agent');
  console.log(`   server : ${serverUrl}`);
  console.log(`   project: ${options.key}`);
  if (options.storageState) console.log(`   login  : ${options.storageState}`);
  console.log('');

  const agent = startAgent(options.key, {
    serverUrl,
    headless: !options.headed,
    trace: options.trace,
    storageStatePath: options.storageState,
    apiKey: options.apiKey,
  });

  let stopping = false;
  const exit = () => {
    if (stopping) process.exit(1);
    stopping = true;
    if (agent.activeRuns() > 0)
      console.log(`Cancelling ${agent.activeRuns()} run(s) in progress...`);
    void agent.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}
