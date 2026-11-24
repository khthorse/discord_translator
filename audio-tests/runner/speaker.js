import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Client, GatewayIntentBits } from 'discord.js';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const MAX_FIXTURE_BYTES = 100 * 1024 * 1024;

function parsePcmWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Fixture must be a valid PCM WAV file.');
  }

  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkSize;
    if (end > buffer.length) throw new Error('WAV file contains an incomplete chunk.');

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) throw new Error('WAV format chunk is too short.');
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(start, end);
    }

    offset = end + (chunkSize % 2);
  }

  if (!format || !data) throw new Error('WAV file is missing its format or audio data chunk.');
  if (
    format.audioFormat !== 1 ||
    format.channels !== CHANNELS ||
    format.sampleRate !== SAMPLE_RATE ||
    format.bitsPerSample !== BITS_PER_SAMPLE
  ) {
    throw new Error('Fixture must be uncompressed PCM, 48 kHz, stereo, 16-bit WAV.');
  }
  if (data.length === 0 || data.length % (CHANNELS * BITS_PER_SAMPLE / 8) !== 0) {
    throw new Error('WAV audio data is empty or not sample-aligned.');
  }

  return data;
}

function waitForPlayerToFinish(player) {
  return new Promise((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once('error', onError);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function playFixtures({ guildId, channelId, fixtures, gapMs = 1000 }) {
  const token = process.env.AUDIO_TEST_SPEAKER_TOKEN || '';
  if (!token) throw new Error('AUDIO_TEST_SPEAKER_TOKEN is not configured.');
  if (!/^\\d{17,20}$/.test(guildId || '') || !/^\\d{17,20}$/.test(channelId || '')) {
    throw new Error('Valid --guild-id and --channel-id values are required.');
  }
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('Manifest must contain at least one fixture.');
  if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 60_000) {
    throw new Error('Manifest gapMs must be an integer between 0 and 60000.');
  }

  // Validate and load every file before connecting to Discord, so a bad fixture
  // cannot leave a partially played test sequence.
  const loadedFixtures = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (!fixture || typeof fixture.path !== 'string' || !fixture.path) {
      throw new Error(`Manifest fixture ${index + 1} is missing its path.`);
    }
    const stat = await fs.stat(fixture.path);
    if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) {
      throw new Error(`Fixture must be a file no larger than 100 MB: ${fixture.path}`);
    }
    const pcm = parsePcmWav(await fs.readFile(fixture.path));
    const durationMs = Math.round(pcm.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)) * 1000);
    loadedFixtures.push({ ...fixture, pcm, durationMs });
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let connection;
  try {
    await client.login(token);
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel?.isVoiceBased() || !channel.joinable) {
      throw new Error('Speaker bot cannot join the selected voice channel. Check its channel access and Connect permission.');
    }

    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    const player = createAudioPlayer();
    connection.subscribe(player);
    console.log(JSON.stringify({
      event: 'speaker_playlist_ready',
      speakerId: client.user.id,
      guildId,
      channelId,
      fixtureCount: loadedFixtures.length,
      gapMs,
    }));

    for (const [index, fixture] of loadedFixtures.entries()) {
      if (index > 0 && gapMs > 0) await delay(gapMs);
      const scheduledAt = Date.now();
      console.log(JSON.stringify({
        event: 'speaker_playback_scheduled',
        speakerId: client.user.id,
        fixtureId: fixture.id || `fixture-${index + 1}`,
        fixture: fixture.path,
        expectedLanguage: fixture.expectedLanguage || null,
        durationMs: fixture.durationMs,
        scheduledAt: new Date(scheduledAt).toISOString(),
      }));

      const startedAt = Date.now();
      const finished = waitForPlayerToFinish(player);
      const resource = createAudioResource(Readable.from([fixture.pcm]), { inputType: StreamType.Raw });
      player.play(resource);
      await finished;

      console.log(JSON.stringify({
        event: 'speaker_playback_finished',
        speakerId: client.user.id,
        fixtureId: fixture.id || `fixture-${index + 1}`,
        fixture: fixture.path,
        expectedLanguage: fixture.expectedLanguage || null,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        actualDurationMs: Date.now() - startedAt,
        fixtureDurationMs: fixture.durationMs,
      }));
    }
  } finally {
    connection?.destroy();
    client.destroy();
  }
}
