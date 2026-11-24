#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const BASE_URL = 'http://127.0.0.1:8766';
const TOKEN = process.env.AUDIO_TEST_CONTROL_TOKEN || '';

function usage() {
  console.log(`Audio test session control

Usage:
  npm run audio-test -- start --guild-id ID --channel-id ID [--run-id ID]
  npm run audio-test -- stop --guild-id ID

The CLI must run inside the dedicated translator container.
`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function request(path, body) {
  if (TOKEN.length < 32) {
    throw new Error('AUDIO_TEST_CONTROL_TOKEN must be configured with at least 32 characters.');
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Translator control returned HTTP ${response.status}`);
  }
  return result;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help' || action === 'help') {
    usage();
    return;
  }

  const guildId = option(args, '--guild-id');
  if (!/^\d{17,20}$/.test(guildId || '')) {
    throw new Error('--guild-id must be a valid Discord server ID.');
  }

  if (action === 'start') {
    const channelId = option(args, '--channel-id');
    if (!/^\d{17,20}$/.test(channelId || '')) {
      throw new Error('--channel-id must be a valid Discord voice channel ID.');
    }
    const runId = option(args, '--run-id') || `audio-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) {
      throw new Error('--run-id may contain only letters, numbers, underscores and hyphens (max 80 characters).');
    }
    const result = await request('/join', { guildId, channelId, runId });
    console.log(JSON.stringify(result, null, 2));
    console.log(`Translator joined. Run ID: ${runId}`);
    return;
  }

  if (action === 'stop') {
    const result = await request('/leave', { guildId });
    console.log(JSON.stringify(result, null, 2));
    console.log('Translator test session stopped.');
    return;
  }

  usage();
  throw new Error(`Unknown action: ${action}`);
}

main().catch(error => {
  console.error(`Audio test runner: ${error.message}`);
  process.exitCode = 1;
});
