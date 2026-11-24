import fs from 'node:fs/promises';
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

export async function playFixture({ guildId, channelId, fixturePath, startDelayMs = 0 }) {
  const token = process.env.AUDIO_TEST_SPEAKER_TOKEN || '';
  if (!token) throw new Error('AUDIO_TEST_SPEAKER_TOKEN is not configured.');
  if (!/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(channelId || '')) {
    throw new Error('Valid --guild-id and --channel-id values are required.');
  }
  if (!Number.isInteger(startDelayMs) || startDelayMs < 0 || startDelayMs > 3_600_000) {
    throw new Error('--start-delay-ms must be an integer between 0 and 3600000.');
  }

  const stat = await fs.stat(fixturePath);
  if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) {
    throw new Error('Fixture must be a file no larger than 100 MB.');
  }
  const pcm = parsePcmWav(await fs.readFile(fixturePath));
  const durationMs = Math.round(pcm.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)) * 1000);

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

    const scheduledAt = Date.now() + startDelayMs;
    console.log(JSON.stringify({
      event: 'speaker_playback_scheduled',
      speakerId: client.user.id,
      guildId,
      channelId,
      fixture: fixturePath,
      startDelayMs,
      durationMs,
      scheduledAt: new Date(scheduledAt).toISOString(),
    }));

    if (startDelayMs) await new Promise(resolve => setTimeout(resolve, startDelayMs));

    const startedAt = Date.now();
    const finished = waitForPlayerToFinish(player);
    const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
    player.play(resource);
    await finished;

    console.log(JSON.stringify({
      event: 'speaker_playback_finished',
      speakerId: client.user.id,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      actualDurationMs: Date.now() - startedAt,
      fixtureDurationMs: durationMs,
    }));
  } finally {
    connection?.destroy();
    client.destroy();
  }
}
