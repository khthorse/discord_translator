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
  if (format.audioFormat !== 1 || format.channels !== CHANNELS || format.sampleRate !== SAMPLE_RATE || format.bitsPerSample !== BITS_PER_SAMPLE) {
    throw new Error('Fixture must be uncompressed PCM, 48 kHz, stereo, 16-bit WAV.');
  }
  if (data.length === 0 || data.length % (CHANNELS * BITS_PER_SAMPLE / 8) !== 0) {
    throw new Error('WAV audio data is empty or not sample-aligned.');
  }
  return data;
}

function waitForPlayerToFinish(player) {
  return new Promise((resolve, reject) => {
    const onIdle = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => {
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
    };
    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once('error', onError);
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

export async function playFixtures({ guildId, channelId, fixtures, speakers, speakerCredentials }) {
  if (!/^\d{17,20}$/.test(guildId || '') || !/^\d{17,20}$/.test(channelId || '')) {
    throw new Error('Valid guildId and channelId values are required.');
  }
  if (!Array.isArray(fixtures) || fixtures.length === 0) throw new Error('Schedule must contain at least one fixture event.');
  if (!Array.isArray(speakers) || speakers.length < 1) throw new Error('At least one speaker must be configured.');
  if (!Array.isArray(speakerCredentials) || speakerCredentials.length !== speakers.length) {
    throw new Error('Speaker credentials must match the manifest speakers one-to-one.');
  }

  const speakerByKey = new Map(speakers.map(speaker => [speaker.id, speaker]));
  const credentialByKey = new Map(speakerCredentials.map(item => [item.speakerId, item]));
  const pcmByPath = new Map();
  const loadedEvents = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (!fixture || typeof fixture.path !== 'string' || !speakerByKey.has(fixture.speaker)) {
      throw new Error(`Scheduled fixture ${index + 1} has an invalid speaker or path.`);
    }
    if (!Number.isSafeInteger(fixture.startOffsetMs) || fixture.startOffsetMs < 0) {
      throw new Error(`Scheduled fixture ${index + 1} needs a non-negative integer startOffsetMs.`);
    }
    let pcm = pcmByPath.get(fixture.path);
    if (!pcm) {
      const stat = await fs.stat(fixture.path);
      if (!stat.isFile() || stat.size > MAX_FIXTURE_BYTES) throw new Error(`Fixture must be a file no larger than 100 MB: ${fixture.path}`);
      pcm = parsePcmWav(await fs.readFile(fixture.path));
      pcmByPath.set(fixture.path, pcm);
    }
    const durationMs = Math.round(pcm.length / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)) * 1000);
    loadedEvents.push({ ...fixture, pcm, durationMs });
  }

  const sessions = [];
  try {
    for (const speaker of speakers) {
      const credential = credentialByKey.get(speaker.id);
      if (!credential?.token || credential.discordUserId !== speaker.discordUserId) {
        throw new Error(`Missing or mismatched token mapping for manifest speaker ${speaker.id}.`);
      }
      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
      const session = { speaker, client, connection: null, player: null };
      sessions.push(session);
      client.on('error', error => console.error(JSON.stringify({ event: 'speaker_client_error', speakerId: speaker.id, message: error.message })));
      console.log(JSON.stringify({ event: 'speaker_connecting', speakerId: speaker.id }));
      await client.login(credential.token);
      if (client.user.id !== speaker.discordUserId) {
        throw new Error(`Token for ${speaker.id} authenticated as Discord user ${client.user.id}, but manifest expects ${speaker.discordUserId}.`);
      }
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isVoiceBased() || !channel.joinable) {
        throw new Error(`Speaker ${speaker.id} cannot join the selected voice channel. Check View Channel and Connect permissions.`);
      }
      session.connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      session.connection.on('error', error => console.error(JSON.stringify({ event: 'speaker_voice_error', speakerId: speaker.id, message: error.message })));
      await entersState(session.connection, VoiceConnectionStatus.Ready, 20_000);
      session.player = createAudioPlayer();
      session.player.on('error', error => console.error(JSON.stringify({ event: 'speaker_player_error', speakerId: speaker.id, message: error.message })));
      session.connection.subscribe(session.player);
      console.log(JSON.stringify({ event: 'speaker_ready', speakerId: speaker.id, discordUserId: client.user.id }));
    }

    const startAt = Date.now() + 5000;
    console.log(JSON.stringify({ event: 'schedule_armed', startAt: new Date(startAt).toISOString(), eventCount: loadedEvents.length, speakerCount: sessions.length }));
    const tasks = loadedEvents.map(async (fixture, index) => {
      const session = sessions.find(item => item.speaker.id === fixture.speaker);
      const waitMs = startAt + fixture.startOffsetMs - Date.now();
      if (waitMs > 0) await delay(waitMs);
      const player = session.player;
      if (player.state.status !== AudioPlayerStatus.Idle) {
        throw new Error(`Schedule collision: speaker ${fixture.speaker} was still playing when ${fixture.id || index + 1} was due.`);
      }
      const startedAt = Date.now();
      console.log(JSON.stringify({
        event: 'speaker_playback_started',
        runId: fixture.runId || null,
        speakerId: fixture.speaker,
        fixtureId: fixture.id || `fixture-${index + 1}`,
        expectedLanguage: fixture.expectedLanguage || null,
        scheduledOffsetMs: fixture.startOffsetMs,
        actualOffsetMs: startedAt - startAt,
        fixtureDurationMs: fixture.durationMs,
        startedAt: new Date(startedAt).toISOString(),
      }));
      const finished = waitForPlayerToFinish(player);
      player.play(createAudioResource(Readable.from([fixture.pcm]), { inputType: StreamType.Raw }));
      await finished;
      console.log(JSON.stringify({
        event: 'speaker_playback_finished',
        speakerId: fixture.speaker,
        fixtureId: fixture.id || `fixture-${index + 1}`,
        expectedLanguage: fixture.expectedLanguage || null,
        actualDurationMs: Date.now() - startedAt,
      }));
    });
    await Promise.all(tasks);
  } finally {
    for (const session of sessions) {
      session.connection?.destroy();
      session.client.destroy();
    }
  }
}
