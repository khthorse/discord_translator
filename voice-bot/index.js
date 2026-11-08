import './env.js';
import fs from 'node:fs';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
} from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';
import { pcmToWav } from './wav.js';

// ---------------------------------------------------------------- config ---
const {
  DISCORD_TOKEN,
  SERVICE_URL = 'http://127.0.0.1:8000',
  SILENCE_MS = '1000', // how long someone must be quiet before an utterance counts as finished
  MIN_UTTERANCE_MS = '600', // ignore anything shorter (clicks, breaths, keyboard noise)
  MAX_UTTERANCE_MS = '20000', // cut very long monologues so subtitles don't lag behind
  SHOW_ORIGINAL = 'true', // also show the original text below the translation
  RECORD_WAV = 'false', // TESTING ONLY: save each utterance to ./recordings
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const SAMPLE_RATE = 48000; // Discord voice is always 48 kHz
const CHANNELS = 2; // ...and stereo after decoding
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000; // 16-bit samples = 2 bytes
const silenceMs = Number(SILENCE_MS);
const minMs = Number(MIN_UTTERANCE_MS);
const maxMs = Number(MAX_UTTERANCE_MS);
const showOriginal = SHOW_ORIGINAL === 'true';
const recordWav = RECORD_WAV === 'true';

if (recordWav) fs.mkdirSync('recordings', { recursive: true });

// ----------------------------------------------------------------- state ---
// One session per server: the voice connection, where to post subtitles, and a work queue.
/** @type {Map<string, {connection: import('@discordjs/voice').VoiceConnection, guild: import('discord.js').Guild, textChannel: import('discord.js').TextBasedChannel, active: Set<string>, queue: Promise<void>}>} */
const sessions = new Map();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

// -------------------------------------------------------------- commands ---
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  try {
    if (interaction.commandName === 'join') await onJoin(interaction);
    else if (interaction.commandName === 'leave') await onLeave(interaction);
  } catch (err) {
    console.error(err);
    const msg = 'Something went wrong. Check the bot console.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
    else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
});

async function onJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({
      content: 'Join a voice channel first, then run /join again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const perms = interaction.channel?.permissionsFor(client.user);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    return interaction.reply({
      content: "I can't send messages in this text channel. Give me View Channel + Send Messages.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Replace any existing session in this server.
  sessions.get(interaction.guildId)?.connection.destroy();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false, // a deafened bot receives no audio
    selfMute: true, // we never speak (yet)
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    return interaction.editReply('Could not connect to the voice channel in time.');
  }

  const session = {
    connection,
    guild: interaction.guild,
    textChannel: interaction.channel,
    active: new Set(),
    queue: Promise.resolve(),
  };
  sessions.set(interaction.guildId, session);

  // If Discord drops us, give it a few seconds to reconnect on its own; otherwise clean up.
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (sessions.get(interaction.guildId) === session) sessions.delete(interaction.guildId);
  });

  startListening(session);
  await interaction.editReply(
    `Listening in **${voiceChannel.name}**. Subtitles will appear in this channel.`,
  );
}

async function onLeave(interaction) {
  const session = sessions.get(interaction.guildId);
  if (!session) {
    return interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
  }
  session.connection.destroy();
  sessions.delete(interaction.guildId);
  return interaction.reply({ content: 'Left the voice channel.', flags: MessageFlags.Ephemeral });
}

// ------------------------------------------------------------- listening ---
function startListening(session) {
  const receiver = session.connection.receiver;

  // 'start' fires every time a user begins making sound. A pause of a fraction of a second
  // followed by more speech fires it again, which is why we track who is already being captured.
  receiver.speaking.on('start', (userId) => {
    if (session.active.has(userId)) return;
    session.active.add(userId);

    captureUtterance(receiver, userId)
      .then((pcm) => {
        session.active.delete(userId);
        // Chain onto a queue so subtitles are posted in the order people finished speaking.
        session.queue = session.queue
          .then(() => handleUtterance(session, userId, pcm))
          .catch((err) => console.error('Utterance failed:', err));
      })
      .catch((err) => {
        session.active.delete(userId);
        console.error(`Capture failed for ${userId}:`, err.message);
      });
  });
}

// Collects one utterance from one user and resolves with raw 48 kHz stereo PCM.
function captureUtterance(receiver, userId) {
  return new Promise((resolve, reject) => {
    // Per-user stream of Opus packets, ended automatically after `silenceMs` of silence.
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
    });
    // Opus -> raw PCM (16-bit, little-endian, 48 kHz, stereo). 960 samples = one 20 ms frame.
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });

    const chunks = [];
    const cap = setTimeout(() => opusStream.push(null), maxMs); // force-end very long utterances

    const finish = () => {
      clearTimeout(cap);
      resolve(Buffer.concat(chunks));
    };
    decoder.on('data', (chunk) => chunks.push(chunk));
    decoder.on('end', finish);
    decoder.on('error', (err) => {
      clearTimeout(cap);
      reject(err);
    });
    opusStream.on('error', (err) => {
      clearTimeout(cap);
      reject(err);
    });

    opusStream.pipe(decoder);
  });
}

// ------------------------------------------------------------- the work ----
async function handleUtterance(session, userId, pcm) {
  const durationMs = pcm.length / BYTES_PER_MS;
  if (durationMs < minMs) return;

  const member = await session.guild.members.fetch(userId).catch(() => null);
  const name = member?.displayName ?? 'Unknown';
  const wav = pcmToWav(pcm, SAMPLE_RATE, CHANNELS);

  // Testing aid: keep a copy so you can listen to exactly what the bot heard.
  if (recordWav) {
    const file = `recordings/${Date.now()}-${userId}.wav`;
    fs.writeFileSync(file, wav);
    console.log(`Saved ${file} (${(durationMs / 1000).toFixed(1)} s)`);
  }

  let result;
  try {
    const res = await fetch(`${SERVICE_URL}/process?speaker=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`service answered HTTP ${res.status}`);
    result = await res.json();
  } catch (err) {
    console.error('Could not reach the Python service:', err.message);
    return;
  }

  if (!result.original) return; // nothing intelligible was said

  await session.textChannel.send({
    content: formatLine(name, result),
    allowedMentions: { parse: [] }, // never let transcribed speech ping @everyone or roles
  });
}

function formatLine(name, { original, translation }) {
  const safeName = escapeMarkdown(name);
  if (!translation) return `**${safeName}:** ${escapeMarkdown(original)}`.slice(0, 1900);

  let line = `**${safeName}:** ${escapeMarkdown(translation)}`;
  if (showOriginal) line += `\n-# ${escapeMarkdown(original)}`; // "-#" renders as small subtext
  return line.slice(0, 1900); // messages are capped at 2000 characters
}

// -------------------------------------------------------------- shutdown ---
process.on('SIGINT', () => {
  for (const s of sessions.values()) s.connection.destroy();
  client.destroy();
  process.exit(0);
});

await client.login(DISCORD_TOKEN);
