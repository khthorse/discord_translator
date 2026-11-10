
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
  SILENCE_MS = '1000',
  MIN_UTTERANCE_MS = '600',
  MAX_UTTERANCE_MS = '20000',
  SHOW_ORIGINAL = 'true',
  RECORD_WAV = 'false',
  MESSAGE_DELETE_SECONDS = '300',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;
const silenceMs = Number(SILENCE_MS);
const minMs = Number(MIN_UTTERANCE_MS);
const maxMs = Number(MAX_UTTERANCE_MS);
const showOriginal = SHOW_ORIGINAL === 'true';
const recordWav = RECORD_WAV === 'true';
const messageDeleteSeconds = Math.max(0, Number(MESSAGE_DELETE_SECONDS) || 0);

const languageChannelsFile = new URL('./language-channels.json', import.meta.url);
const guildLanguagesFile = new URL('./guild-languages.json', import.meta.url);

if (recordWav) fs.mkdirSync('recordings', { recursive: true });

// -------------------------------------------------------------- state ---

/** @type {Map<string, {connection: import('@discordjs/voice').VoiceConnection, guild: import('discord.js').Guild, active: Set<string>, queue: Promise<void>}>} */
const sessions = new Map();

// ---------------------------------------------------------- file storage ---

function readJsonFile(file, description) {
  try {
    const contents = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(contents);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not read ${description}:`, err);
    }
    return {};
  }
}

// Existing language-channel assignments are kept separate and untouched.
let languageChannels = readJsonFile(languageChannelsFile, 'language-channels.json');

function saveLanguageChannels() {
  fs.writeFileSync(
    languageChannelsFile,
    JSON.stringify(languageChannels, null, 2) + '\n',
  );
}

// New per-server language settings.
let guildLanguageSettings = readJsonFile(
  guildLanguagesFile,
  'guild-languages.json',
);


function defaultGuildSettings() {
  return {
    inputLanguages: ['en', 'es'],
    targetLanguages: ['en', 'es'],
    liveLanguages: ['en', 'es'],
    liveChannelId: null,
  };
}

function getGuildSettings(guildId) {
  if (!guildLanguageSettings[guildId]) {
    guildLanguageSettings[guildId] = defaultGuildSettings();
    saveGuildLanguageSettings();
  }

  const settings = guildLanguageSettings[guildId];

  // Fill in missing properties when loading older configuration files.
  settings.inputLanguages ??= ['en', 'es'];
  settings.targetLanguages ??= ['en', 'es'];
  settings.liveLanguages ??= ['en', 'es'];
  settings.liveChannelId ??= null;

  // Live languages must always be enabled translation targets.
  settings.liveLanguages = settings.liveLanguages.filter(
    language => settings.targetLanguages.includes(language),
  );

  return settings;
}

function saveGuildLanguageSettings() {
  fs.writeFileSync(
    guildLanguagesFile,
    JSON.stringify(guildLanguageSettings, null, 2) + '\n',
  );
}


function getLanguageChannelId(guildId, language) {
  return languageChannels[guildId]?.[language] ?? null;
}

function languageFlag(language) {
  const flags = {
    en: '🇺🇸',
    es: '🇪🇸',
    fr: '🇫🇷',
    de: '🇩🇪',
    it: '🇮🇹',
    pt: '🇵🇹',
    'pt-br': '🇧🇷',
    nl: '🇳🇱',
    sv: '🇸🇪',
    no: '🇳🇴',
    da: '🇩🇰',
    fi: '🇫🇮',
    pl: '🇵🇱',
    cs: '🇨🇿',
    el: '🇬🇷',
    tr: '🇹🇷',
    ru: '🇷🇺',
    uk: '🇺🇦',
    ja: '🇯🇵',
    ko: '🇰🇷',
    zh: '🇨🇳',
    'zh-tw': '🇹🇼',
    hi: '🇮🇳',
    th: '🇹🇭',
    vi: '🇻🇳',
    id: '🇮🇩',
    ms: '🇲🇾',
    he: '🇮🇱',
    ro: '🇷🇴',
    hu: '🇭🇺',
  };

  const code = String(language || '').toLowerCase().replace('_', '-');
  return flags[code] || flags[code.split('-')[0]] || '🌐';
}

// ------------------------------------------------------------- messaging ---

async function sendBotMessage(channel, content) {
  if (!channel?.isTextBased?.() || !channel.isSendable?.()) return null;

  const message = await channel.send({
    content: content.slice(0, 1900),
    allowedMentions: { parse: [] },
  });

  if (messageDeleteSeconds > 0) {
    const timer = setTimeout(() => {
      message.delete().catch((err) => {
        if (err.code !== 10008 && err.code !== 50013) {
          console.warn('Could not auto-delete bot subtitle:', err.message);
        }
      });
    }, messageDeleteSeconds * 1000);

    timer.unref?.();
  }

  return message;
}

async function getGuildTextChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.fetch(channelId).catch(() => null);
}

// -------------------------------------------------------------- Discord ---

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
    if (interaction.commandName === 'join') {
      await onJoin(interaction);
    } else if (interaction.commandName === 'leave') {
      await onLeave(interaction);
    } else if (interaction.commandName === 'language-channel') {
      await onLanguageChannel(interaction);
    } else if (interaction.commandName === 'language') {
      await onLanguage(interaction);
    } else if (interaction.commandName === 'live-channel') {
      await onLiveChannel(interaction);
    }
  } catch (err) {
    console.error(err);

    const msg = 'Something went wrong. Check the bot console.';

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({
        content: msg,
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

function hasManageServerPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function requireManageServer(interaction) {
  if (hasManageServerPermission(interaction)) return true;

  await interaction.reply({
    content: 'You need the **Manage Server** permission to change these settings.',
    flags: MessageFlags.Ephemeral,
  });

  return false;
}

// ----------------------------------------------------------- join / leave ---

async function onJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({
      content: 'Join a voice channel first, then run /join again.',
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
    selfDeaf: false,
    selfMute: true,
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
    active: new Set(),
    queue: Promise.resolve(),
  };

  sessions.set(interaction.guildId, session);

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
    if (sessions.get(interaction.guildId) === session) {
      sessions.delete(interaction.guildId);
    }
  });

  startListening(session);

  const settings = getGuildSettings(interaction.guildId);
  const liveStatus = settings.liveChannelId
    ? 'The configured live channel will receive selected translations.'
    : 'No live translation channel is configured yet.';

  await interaction.editReply(
    `Listening in **${voiceChannel.name}**. Translations will go to configured language channels. ${liveStatus}`,
  );
}

async function onLeave(interaction) {
  const session = sessions.get(interaction.guildId);

  if (!session) {
    return interaction.reply({
      content: "I'm not in a voice channel.",
      flags: MessageFlags.Ephemeral,
    });
  }

  session.connection.destroy();
  sessions.delete(interaction.guildId);

  return interaction.reply({
    content: 'Left the voice channel.',
    flags: MessageFlags.Ephemeral,
  });
}

// ------------------------------------------------------- language channels ---

async function onLanguageChannel(interaction) {
  if (!await requireManageServer(interaction)) return;

  const action = interaction.options.getSubcommand();

  if (action === 'list') {
    const mapping = languageChannels[interaction.guildId] ?? {};

    const lines = Object.entries(mapping).map(([code, id]) => {
      const channel = interaction.guild.channels.cache.get(id);
      return `• **${code}** → ${channel ? `<#${id}>` : `deleted/missing channel (${id})`}`;
    });

    return interaction.reply({
      content: lines.length
        ? `**Language channel mappings**\n${lines.join('\n')}`
        : 'No language channels configured yet. Use `/language-channel set`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const language = interaction.options.getString('language', true)
    .trim()
    .toLowerCase();

  if (!/^[a-z]{2,3}$/.test(language)) {
    return interaction.reply({
      content: 'Use a 2- or 3-letter language code, such as `en`, `es`, `no`, or `de`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remove') {
    if (!languageChannels[interaction.guildId]?.[language]) {
      return interaction.reply({
        content: `No channel is set for **${language}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    delete languageChannels[interaction.guildId][language];

    if (Object.keys(languageChannels[interaction.guildId]).length === 0) {
      delete languageChannels[interaction.guildId];
    }

    saveLanguageChannels();

    return interaction.reply({
      content: `Removed the channel mapping for **${language}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'set') {
    const channel = interaction.options.getChannel('channel', true);

    if (!channel.isTextBased() || !channel.guild) {
      return interaction.reply({
        content: 'Choose a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const perms = channel.permissionsFor(client.user);

    if (!perms?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])) {
      return interaction.reply({
        content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    languageChannels[interaction.guildId] ??= {};
    languageChannels[interaction.guildId][language] = channel.id;

    saveLanguageChannels();

    return interaction.reply({
      content: `Speech and translations in **${language}** will be posted in <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// -------------------------------------------------------- language settings ---

async function onLanguage(interaction) {
  if (!await requireManageServer(interaction)) return;

  const group = interaction.options.getSubcommandGroup(true);
  const action = interaction.options.getSubcommand();
  const language = action === 'list'
    ? null
    : interaction.options.getString('language', true).toLowerCase();

  const settings = getGuildSettings(interaction.guildId);

  const propertyByGroup = {
    input: 'inputLanguages',
    target: 'targetLanguages',
    live: 'liveLanguages',
  };

  const property = propertyByGroup[group];

  if (!property) {
    return interaction.reply({
      content: 'Unknown language setting.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const languages = settings[property];

  if (action === 'list') {
    const lines = languages.map(code => `• **${code}**`);

    return interaction.reply({
      content: lines.length
        ? `**${group === 'input' ? 'Input' : group === 'target' ? 'Target' : 'Live'} languages**\n${lines.join('\n')}`
        : `No ${group} languages are enabled.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!/^[a-z]{2,3}$/.test(language)) {
    return interaction.reply({
      content: 'Invalid language code.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'add') {
    if (languages.includes(language)) {
      return interaction.reply({
        content: `**${language}** is already enabled for ${group} languages.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (group === 'live' && !settings.targetLanguages.includes(language)) {
      return interaction.reply({
        content: `Enable **${language}** as a target language first with \`/language target add\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    languages.push(language);
    saveGuildLanguageSettings();

    return interaction.reply({
      content: `Added **${language}** to ${group} languages.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remove') {
    if (!languages.includes(language)) {
      return interaction.reply({
        content: `**${language}** is not enabled for ${group} languages.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (group === 'input' && languages.length === 1) {
      return interaction.reply({
        content: 'At least one input language must remain enabled.',
        flags: MessageFlags.Ephemeral,
      });
    }

    settings[property] = languages.filter(code => code !== language);

    // A language cannot remain in the live feed after it stops being a target.
    if (group === 'target') {
      settings.liveLanguages = settings.liveLanguages.filter(
        code => code !== language,
      );
    }

    saveGuildLanguageSettings();

    return interaction.reply({
      content: `Removed **${language}** from ${group} languages.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ------------------------------------------------------------ live channel ---

async function onLiveChannel(interaction) {
  if (!await requireManageServer(interaction)) return;

  const action = interaction.options.getSubcommand();
  const settings = getGuildSettings(interaction.guildId);

  if (action === 'show') {
    if (!settings.liveChannelId) {
      return interaction.reply({
        content: 'No live translation channel is configured. Use `/live-channel set`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const channel = await getGuildTextChannel(
      interaction.guild,
      settings.liveChannelId,
    );

    return interaction.reply({
      content: channel
        ? `Live translations are sent to <#${channel.id}>.`
        : `The configured channel (${settings.liveChannelId}) no longer exists. Set a new one with \`/live-channel set\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remove') {
    settings.liveChannelId = null;
    saveGuildLanguageSettings();

    return interaction.reply({
      content: 'Removed the live translation channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'set') {
    const channel = interaction.options.getChannel('channel', true);

    if (!channel.isTextBased() || !channel.guild) {
      return interaction.reply({
        content: 'Choose a server text channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const perms = channel.permissionsFor(client.user);

    if (!perms?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ])) {
      return interaction.reply({
        content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    settings.liveChannelId = channel.id;
    saveGuildLanguageSettings();

    return interaction.reply({
      content: `Live translations will be sent to <#${channel.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ------------------------------------------------------------- listening ---

function startListening(session) {
  const receiver = session.connection.receiver;

  receiver.speaking.on('start', (userId) => {
    if (session.active.has(userId)) return;
    session.active.add(userId);

    captureUtterance(receiver, userId)
      .then((pcm) => {
        session.active.delete(userId);

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

function captureUtterance(receiver, userId) {
  return new Promise((resolve, reject) => {
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: silenceMs,
      },
    });

    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960,
    });

    const chunks = [];
    const cap = setTimeout(() => opusStream.push(null), maxMs);

    const finish = () => {
      clearTimeout(cap);
      resolve(Buffer.concat(chunks));
    };

    decoder.on('data', chunk => chunks.push(chunk));
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

  if (recordWav) {
    const file = `recordings/${Date.now()}-${userId}.wav`;
    fs.writeFileSync(file, wav);
    console.log(`Saved ${file} (${(durationMs / 1000).toFixed(1)} s)`);
  }

  // Read this server's settings for every utterance.
  const settings = getGuildSettings(session.guild.id);

  let result;

  try {
    const params = new URLSearchParams({
      speaker: userId,
      candidates: settings.inputLanguages.join(','),
      targets: settings.targetLanguages.join(','),
      translate: settings.targetLanguages.length > 0 ? 'true' : 'false',
    });

    const res = await fetch(`${SERVICE_URL}/process?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(`service answered HTTP ${res.status}`);
    }

    result = await res.json();
  } catch (err) {
    console.error('Could not reach the Python service:', err.message);
    return;
  }

  if (!result.original) return;

  const sourceLanguage = result.language;
  const translations = result.translations ?? {};

  // Original transcript goes to its source-language channel,
  // even when that language is not a translation target.
  const sourceChannelId = sourceLanguage
    && getLanguageChannelId(session.guild.id, sourceLanguage);

  if (sourceChannelId) {
    const sourceChannel = await getGuildTextChannel(
      session.guild,
      sourceChannelId,
    );

    if (sourceChannel) {
      await sendBotMessage(
        sourceChannel,
        `**${languageFlag(sourceLanguage)} ${escapeMarkdown(name)}:** ${escapeMarkdown(result.original)}`,
      );
    }
  }

  // Send each enabled translation to its own language channel.
  for (const [targetLanguage, translatedText] of Object.entries(translations)) {
    if (!translatedText) continue;
    if (!settings.targetLanguages.includes(targetLanguage)) continue;

    const targetChannelId = getLanguageChannelId(
      session.guild.id,
      targetLanguage,
    );

    if (!targetChannelId) continue;

    const targetChannel = await getGuildTextChannel(
      session.guild,
      targetChannelId,
    );

    if (targetChannel) {
      await sendBotMessage(
        targetChannel,
        `**${languageFlag(targetLanguage)} ${escapeMarkdown(name)}:** ${escapeMarkdown(translatedText)}`,
      );
    }
  }

 
  // The live channel always receives the original transcript,
  // followed by only the translations selected by the server admin.
  if (settings.liveChannelId) {
    const liveChannel = await getGuildTextChannel(
      session.guild,
      settings.liveChannelId,
    );

    if (liveChannel) {
      const liveLines = settings.liveLanguages
        .filter(language => settings.targetLanguages.includes(language))
        .map(language => {
          const translatedText = translations[language];
          if (!translatedText) return null;

          return `**${languageFlag(language)} ${language.toUpperCase()}:** ${escapeMarkdown(translatedText)}`;
        })
        .filter(Boolean);

      const originalLanguage = sourceLanguage
        ? `${languageFlag(sourceLanguage)} ${sourceLanguage.toUpperCase()}`
        : '🌐 Original';

      const liveMessage = [
        `**${escapeMarkdown(name)}**`,
        '',
        `**Original (${originalLanguage}):**`,
        escapeMarkdown(result.original),
        ...liveLines.length > 0 ? ['', ...liveLines] : [],
      ].join('\n');

      await sendBotMessage(liveChannel, liveMessage);
    }
  }
}

// -------------------------------------------------------------- shutdown ---

process.on('SIGINT', () => {
  for (const session of sessions.values()) {
    session.connection.destroy();
  }

  client.destroy();
  process.exit(0);
});

await client.login(DISCORD_TOKEN);
