#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { playFixtures } from './speaker.js';

const CONTROL_PORT = Number(process.env.AUDIO_TEST_CONTROL_PORT || '8766');
const BASE_URL = `http://127.0.0.1:${CONTROL_PORT}`;
const TOKEN = process.env.AUDIO_TEST_CONTROL_TOKEN || '';
const DEFAULT_GUILD_ID = process.env.AUDIO_TEST_GUILD_ID || '';
const DEFAULT_CHANNEL_ID = process.env.AUDIO_TEST_CHANNEL_ID || '';
const SPEAKER_IDS = (process.env.AUDIO_TEST_SPEAKER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
const SPEAKER_TOKENS = (process.env.AUDIO_TEST_SPEAKER_TOKENS || '').split(',').map(v => v.trim()).filter(Boolean);
const AUDIO_TEST_ROOT = '/audio-tests';
const FIXTURE_ROOT = path.resolve(AUDIO_TEST_ROOT, 'fixtures');

function usage() {
  console.log(`Audio test session control

Usage:
  npm run audio-test -- start --guild-id ID --channel-id ID [--run-id ID]
  npm run audio-test -- short [--language-mode auto|configured]
  npm run audio-test -- long [--language-mode auto|configured]
  npm run audio-test -- run --guild-id ID --channel-id ID --manifest /audio-tests/manifest.json
  npm run audio-test -- stop --guild-id ID

The CLI must run inside the dedicated translator container.
`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function request(endpoint, body) {
  if (TOKEN.length < 32) {
    throw new Error('AUDIO_TEST_CONTROL_TOKEN must be configured with at least 32 characters.');
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
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

async function loadManifest(manifestPath) {
  if (!manifestPath) throw new Error('--manifest PATH is required.');
  const resolvedManifest = path.resolve(manifestPath);
  const parsed = JSON.parse(await fs.readFile(resolvedManifest, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.fixtures) || parsed.fixtures.length === 0) {
    throw new Error('Manifest must have version 1 and a non-empty fixtures array.');
  }
  const gapMs = parsed.gapMs ?? 1000;
  if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 60_000) {
    throw new Error('Manifest gapMs must be an integer between 0 and 60000.');
  }

  if (!Array.isArray(parsed.speakers) || parsed.speakers.length === 0) {
    throw new Error('Manifest must define at least one speaker in speakers[].');
  }

  const speakers = {};
  const speakerIds = new Set();
  const botIds = new Set();
  for (const [index, speaker] of parsed.speakers.entries()) {
    if (!speaker || typeof speaker.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(speaker.id)) {
      throw new Error(`Manifest speaker ${index + 1} needs a valid id.`);
    }
    if (!/^\d{17,20}$/.test(String(speaker.discordUserId || ''))) {
      throw new Error(`Manifest speaker ${speaker.id} needs a valid discordUserId.`);
    }
    if (speakerIds.has(speaker.id) || botIds.has(speaker.discordUserId)) {
      throw new Error('Manifest speaker IDs and Discord user IDs must be unique.');
    }
    const languages = speaker.languages ?? [];
    if (!Array.isArray(languages) || languages.length > 20 || languages.some(code => typeof code !== 'string' || !/^[a-z]{2,3}$/.test(code))) {
      throw new Error(`Manifest speaker ${speaker.id} has an invalid languages list.`);
    }
    speakerIds.add(speaker.id);
    botIds.add(speaker.discordUserId);
    speakers[speaker.id] = { discordUserId: speaker.discordUserId, languages };
  }

  const fixtures = parsed.fixtures.map((fixture, index) => {
    if (!fixture || typeof fixture.path !== 'string' || !fixture.path) {
      throw new Error(`Manifest fixture ${index + 1} is missing its path.`);
    }
    if (!speakerIds.has(fixture.speaker)) {
      throw new Error(`Manifest fixture ${index + 1} references unknown speaker: ${fixture.speaker}`);
    }
    const resolvedFixture = path.resolve(AUDIO_TEST_ROOT, fixture.path);
    if (!resolvedFixture.startsWith(FIXTURE_ROOT + path.sep)) {
      throw new Error(`Manifest fixture ${index + 1} must be inside /audio-tests/fixtures.`);
    }
    return { ...fixture, path: resolvedFixture };
  });
  return { fixtures, gapMs, speakers: Object.entries(speakers).map(([id, value]) => ({ id, ...value })) };
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === '--help' || action === 'help') {
    usage();
    return;
  }

  const guildId = option(args, '--guild-id') || DEFAULT_GUILD_ID;
  if (!/^\d{17,20}$/.test(guildId || '')) {
    throw new Error('Set AUDIO_TEST_GUILD_ID or pass a valid --guild-id.');
  }

  if (['short', 'long', 'run'].includes(action)) {
    const channelId = option(args, '--channel-id') || DEFAULT_CHANNEL_ID;
    if (!/^\d{17,20}$/.test(channelId || '')) throw new Error('Set AUDIO_TEST_CHANNEL_ID or pass a valid --channel-id.');
    const mode = option(args, '--language-mode') || 'auto';
    if (!['auto', 'configured'].includes(mode)) throw new Error('--language-mode must be auto or configured.');
    const manifest = await loadManifest(option(args, '--manifest') || '/audio-tests/manifest.json');
    if (!SPEAKER_IDS.length || !SPEAKER_TOKENS.length || SPEAKER_IDS.length !== SPEAKER_TOKENS.length) {
      throw new Error('Set AUDIO_TEST_SPEAKER_IDS and AUDIO_TEST_SPEAKER_TOKENS as matching comma-separated lists.');
    }
    if (new Set(SPEAKER_IDS).size !== SPEAKER_IDS.length || SPEAKER_TOKENS.some(token => !token)) {
      throw new Error('Speaker IDs must be unique and every paired token must be non-empty.');
    }
    const speakerCredentials = manifest.speakers.map(speaker => {
      const index = SPEAKER_IDS.indexOf(speaker.discordUserId);
      if (index < 0 || !SPEAKER_TOKENS[index]) throw new Error('No paired token configured for manifest speaker ' + speaker.id + '.');
      return { speakerId: speaker.id, discordUserId: speaker.discordUserId, token: SPEAKER_TOKENS[index] };
    });
    const profile = action === 'long' ? 'long' : action === 'short' ? 'short' : 'custom';
    const durationMs = profile === 'long' ? 24 * 60 * 1000 : profile === 'short' ? 4 * 60 * 1000 : null;
    const fixturesBySpeaker = new Map(manifest.speakers.map(s => [s.id, manifest.fixtures.filter(f => f.speaker === s.id)]));
    for (const speaker of manifest.speakers) {
      if (!fixturesBySpeaker.get(speaker.id).length) throw new Error('No fixtures defined for speaker ' + speaker.id + '.');
    }
    const schedule = [];
    if (profile === 'custom') {
      manifest.fixtures.forEach((fixture, index) => schedule.push({ ...fixture, startOffsetMs: fixture.startOffsetMs ?? index * (manifest.gapMs + 1000) }));
    } else {
      const offsets = [0, 20000, 40000];
      const cycles = Math.floor(durationMs / 75000);
      for (let cycle = 0; cycle < cycles; cycle++) {
        manifest.speakers.forEach((speaker, speakerIndex) => {
          const choices = fixturesBySpeaker.get(speaker.id);
          const fixture = choices[cycle % choices.length];
          const startOffsetMs = cycle * 75000 + offsets[speakerIndex % offsets.length];
          if (startOffsetMs < durationMs) schedule.push({ ...fixture, startOffsetMs });
        });
      }
    }
    const speakerLanguages = Object.fromEntries(manifest.speakers.map(s => [s.discordUserId, mode === 'auto' ? [] : s.languages]));
    const runId = 'audio-' + profile + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    let translatorStarted = false;
    try {
      const started = await request('/join', { guildId, channelId, runId, speakerLanguages });
      translatorStarted = true;
      console.log(JSON.stringify({ event: 'test_run_started', runId, profile, languageMode: mode, fixtureEvents: schedule.length, plannedDurationMs: durationMs }));
      console.log(JSON.stringify(started, null, 2));
      await playFixtures({ guildId, channelId, fixtures: schedule, speakers: manifest.speakers, speakerCredentials });
      const deadline = Date.now() + 180000;
      let status = await request('/status', { guildId });
      while (status.joined && (status.activeSpeakers > 0 || status.queuedSpeakers > 0 || status.pendingJobs > 0 || status.runningJobs > 0 || status.waitingJobs > 0) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        status = await request('/status', { guildId });
      }
      if (status.joined && (status.activeSpeakers > 0 || status.queuedSpeakers > 0 || status.pendingJobs > 0 || status.runningJobs > 0 || status.waitingJobs > 0)) throw new Error('Timed out waiting for translator processing to drain.');
      console.log(JSON.stringify({ event: 'test_run_completed', runId, profile, languageMode: mode }));
    } finally {
      if (translatorStarted) await request('/leave', { guildId });
    }
    return;
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
    const deadline = Date.now() + 120_000;
    let status = await request('/status', { guildId });
    while (
      status.joined &&
      (status.activeSpeakers > 0 || status.queuedSpeakers > 0 || status.pendingJobs > 0 || status.runningJobs > 0 || status.waitingJobs > 0) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 500));
      status = await request('/status', { guildId });
    }
    if (status.joined && (status.activeSpeakers > 0 || status.queuedSpeakers > 0 || status.pendingJobs > 0 || status.runningJobs > 0 || status.waitingJobs > 0)) {
      console.warn('Timed out waiting for the translator queue to drain; stopping the session anyway.');
    } else {
      console.log('Translator processing queue is drained.');
    }
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
