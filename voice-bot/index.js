
import './env.js';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
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
import { broadcastOverlayMessage, setOverlayLanguages, startOverlayRelay, stopOverlayRelay } from './overlay-relay.js';
import { handleTranslateInteraction } from './text-translation.js';

// ---------------------------------------------------------------- config ---
const {
  DISCORD_TOKEN,
  SERVICE_URL = 'http://127.0.0.1:8000',
  MAX_CONCURRENT_UTTERANCES = '3',
  SILENCE_MS = '500',
  MIN_UTTERANCE_MS = '500',
  MAX_UTTERANCE_MS = '4000',
  SEGMENT_SEARCH_MS = '1200',
  SEGMENT_MIN_MS = '2500',
  SEGMENT_QUIET_RMS = '700',
  SHOW_ORIGINAL = 'true',
  RECORD_WAV = 'false',
  MESSAGE_DELETE_SECONDS = '300',
  AUDIO_TEST_CONTROL_ENABLED = 'false',
  AUDIO_TEST_CONTROL_PORT = '8766',
  AUDIO_TEST_CONTROL_TOKEN = '',
  AUDIO_TEST_SPEAKER_IDS = '',
} = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;
const silenceMs = Math.max(100, Number(SILENCE_MS) || 700);
const minMs = Math.max(0, Number(MIN_UTTERANCE_MS) || 500);
const maxMs = Math.max(1000, Number(MAX_UTTERANCE_MS) || 8000);
const minUtteranceBytes = minMs * BYTES_PER_MS;
const maxUtteranceBytes = maxMs * BYTES_PER_MS;
const segmentSearchBytes = Math.max(0, Number(SEGMENT_SEARCH_MS) || 1200) * BYTES_PER_MS;
const segmentMinBytes = Math.max(1000, Number(SEGMENT_MIN_MS) || 2500) * BYTES_PER_MS;
const segmentQuietRms = Math.max(0, Number(SEGMENT_QUIET_RMS) || 700);
const showOriginal = SHOW_ORIGINAL === 'true';
const recordWav = RECORD_WAV === 'true';
const messageDeleteSeconds = Math.max(0, Number(MESSAGE_DELETE_SECONDS) || 0);
const maxConcurrentUtterances = Math.max(1, Number(MAX_CONCURRENT_UTTERANCES) || 3);
const audioTestSpeakerIds = new Set(AUDIO_TEST_SPEAKER_IDS.split(',').map(id => id.trim()).filter(Boolean));

const dataDir = process.env.DATA_DIR || fileURLToPath(new URL('.', import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });
const audioTestLogDir = path.join(dataDir, 'audio-test-logs');

function logEvent(event, fields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  });
  console.log(line);
  if (fields.runId) {
    try {
      fs.mkdirSync(audioTestLogDir, { recursive: true });
      fs.appendFileSync(path.join(audioTestLogDir, `${fields.runId}.jsonl`), `${line}\n`);
    } catch (error) {
      console.error('Could not write audio test event log:', error.message);
    }
  }
}

const languageChannelsFile = path.join(dataDir, 'language-channels.json');
const guildLanguagesFile = path.join(dataDir, 'guild-languages.json');
const userLanguagePreferencesFile = path.join(dataDir, 'user-language-preferences.json');

if (recordWav) fs.mkdirSync(path.join(dataDir, 'recordings'), { recursive: true });

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

function saveLanguageChannels(guildId) {
  fs.writeFileSync(
    languageChannelsFile,
    JSON.stringify(languageChannels, null, 2) + '\n',
  );
  if (guildId && guildLanguageSettings[guildId]) {
    guildLanguageSettings[guildId].ignoredSetupWarnings = (guildLanguageSettings[guildId].ignoredSetupWarnings || []).filter(id => id !== 'output-channels');
    saveGuildLanguageSettings();
  }
}

// New per-server language settings.
let guildLanguageSettings = readJsonFile(
  guildLanguagesFile,
  'guild-languages.json',
);

function refreshOverlayLanguages() {
  const languages = new Set(['en', 'es']);
  for (const settings of Object.values(guildLanguageSettings)) {
    for (const language of settings?.targetLanguages || []) {
      languages.add(language);
    }
  }
  setOverlayLanguages([...languages].map(code => ({
    code,
    name: new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase(),
    flag: languageFlag(code),
  })));
}

refreshOverlayLanguages();
startOverlayRelay();


function defaultGuildSettings() {
  return {
    inputLanguages: ['en', 'es'],
    targetLanguages: ['en', 'es'],
    standardLanguages: ['en', 'es'],
    liveLanguages: ['en', 'es'],
    liveChannelId: null,
    liveFeedStatus: 'not-configured',
    translationOutputsStatus: 'configured',
    ignoredSetupWarnings: [],
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
  settings.standardLanguages ??= ['en', 'es'];
  settings.liveLanguages ??= ['en', 'es'];
  settings.liveChannelId ??= null;
  settings.liveFeedStatus ??= settings.liveChannelId ? 'configured' : 'not-configured';
  settings.translationOutputsStatus ??= settings.targetLanguages.length ? 'configured' : 'not-configured';
  settings.ignoredSetupWarnings ??= [];

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
  refreshOverlayLanguages();
}

// Per-member preferences are scoped to a guild and stored separately from
// server-wide language settings.
let userLanguagePreferences = readJsonFile(userLanguagePreferencesFile, 'user-language-preferences.json');

function getUserLanguagePreferences(guildId, userId) {
  return userLanguagePreferences[guildId]?.[userId] ?? [];
}

function saveUserLanguagePreferences(guildId, userId, languages) {
  userLanguagePreferences[guildId] ??= {};
  if (languages.length) {
    userLanguagePreferences[guildId][userId] = [...new Set(languages)];
  } else {
    delete userLanguagePreferences[guildId][userId];
    if (!Object.keys(userLanguagePreferences[guildId]).length) delete userLanguagePreferences[guildId];
  }
  fs.writeFileSync(userLanguagePreferencesFile, JSON.stringify(userLanguagePreferences, null, 2) + '\n');
}

function languageDisplayName(code) {
  return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
}

const SETUP_LANGUAGE_CODES = ['en', 'es', 'no', 'nn', 'sv', 'da', 'fi', 'de', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'ja', 'ko', 'zh'];

function userSetupComponents(settings, selected) {
  const allowed = settings.inputLanguages.slice(0, 25);
  if (!allowed.length) return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('user-setup:finish').setLabel('Finish').setStyle(ButtonStyle.Success),
  )];
  const menu = new StringSelectMenuBuilder()
    .setCustomId('user-setup:languages')
    .setPlaceholder('Choose the languages you speak')
    .setMinValues(1)
    .setMaxValues(allowed.length)
    .addOptions(allowed.map(code => ({ label: languageDisplayName(code), value: code, default: selected.includes(code) })));
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('user-setup:automatic').setLabel('Use automatic detection').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('user-setup:finish').setLabel('Finish').setStyle(ButtonStyle.Success),
    ),
  ];
}



function setupSummary(guildId, guild = null) {
  const settings = getGuildSettings(guildId);
  const mappings = languageChannels[guildId] || {};
  const outputLines = settings.targetLanguages.map(code =>
    `• ${languageDisplayName(code)}: ${mappings[code] ? (guild && !guild.channels.cache.has(mappings[code]) ? 'deleted/missing channel' : `<#${mappings[code]}>`) : settings.ignoredSetupWarnings.includes('output-channels') ? 'ignored for now' : 'not assigned'}`,
  );
  return [
    '**Server setup summary**',
    `Input languages: ${settings.inputLanguages.length ? settings.inputLanguages.map(languageDisplayName).join(', ') : 'none (automatic detection)'}`,
    `Output languages: ${settings.targetLanguages.length ? settings.targetLanguages.map(languageDisplayName).join(', ') : settings.translationOutputsStatus === 'disabled' ? 'disabled intentionally' : 'none / not configured'}`,
    ...outputLines,
    `Live translations: ${settings.liveChannelId ? (guild && !guild.channels.cache.has(settings.liveChannelId) ? 'deleted/missing channel' : `<#${settings.liveChannelId}>`) : settings.liveFeedStatus === 'disabled' ? 'disabled intentionally' : settings.ignoredSetupWarnings.includes('live-channel') ? 'ignored for now' : 'not configured'}`,
    `Live-feed languages: ${settings.liveLanguages.length ? settings.liveLanguages.map(languageDisplayName).join(', ') : 'none selected'}`,
  ].join('\n');
}


function getSetupWarnings(guildId, guild = null) {
  const settings = getGuildSettings(guildId);
  const mappings = languageChannels[guildId] || {};
  const warnings = [];
  if (!settings.inputLanguages.length) warnings.push({ id: 'input-languages', text: 'No input languages are restricted; Whisper will use automatic language detection.' });
  const missingOutputs = settings.targetLanguages.filter(code =>
    !mappings[code] || (guild && !guild.channels.cache.has(mappings[code])),
  );
  if (missingOutputs.length) warnings.push({ id: 'output-channels', text: `No output channel assigned for: ${missingOutputs.map(languageDisplayName).join(', ')}.` });
  if (!settings.targetLanguages.length && settings.translationOutputsStatus !== 'disabled') warnings.push({ id: 'target-languages', text: 'No translation output languages are enabled.' });
  if ((!settings.liveChannelId || (guild && !guild.channels.cache.has(settings.liveChannelId))) && settings.liveFeedStatus !== 'disabled') warnings.push({ id: 'live-channel', text: 'The combined live translations channel is not configured or no longer exists.' });
  return warnings.filter(item => !settings.ignoredSetupWarnings.includes(item.id));
}

function setupStatusMessage(guildId, guild = null) {
  const warnings = getSetupWarnings(guildId, guild);
  const status = setupSummary(guildId, guild);
  if (!warnings.length) return `${status}\n\nSetup checks look good.`;
  return `${status}\n\n**Needs attention**\n${warnings.map(item => `• ${item.text}`).join('\n')}`;
}

function setupComponents(settings, guildId) {
  const progress = settings.setupProgress || { step: 'input' };
  const languages = SETUP_LANGUAGE_CODES;
  if (progress.step === 'input' || progress.step === 'target') {
    const isInput = progress.step === 'input';
    const selected = isInput ? settings.inputLanguages : settings.targetLanguages;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(isInput ? 'setup:input' : 'setup:target')
      .setPlaceholder(isInput ? 'Select languages people may speak' : 'Select translation output languages')
      .setMinValues(1)
      .setMaxValues(languages.length)
      .addOptions(languages.map(code => ({ label: languageDisplayName(code), value: code, default: selected.includes(code) })));
    const rows = [new ActionRowBuilder().addComponents(menu)];
    if (isInput) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:automatic-input').setLabel('Use unrestricted automatic detection').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:continue-input').setLabel('Continue').setStyle(ButtonStyle.Primary),
      ));
    } else {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:no-targets').setLabel('Disable translation outputs').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:continue-target').setLabel('Continue').setStyle(ButtonStyle.Primary),
      ));
    }
    return rows;
  }
  if (progress.step === 'outputs') {
    const targets = settings.targetLanguages.slice(0, 25);
    if (!targets.length) return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:outputs-done').setLabel('Continue').setStyle(ButtonStyle.Primary))];
    const menu = new StringSelectMenuBuilder().setCustomId('setup:output-language').setPlaceholder('Choose an output language to assign').addOptions(targets.map(code => ({ label: languageDisplayName(code), value: code })));
    return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:outputs-done').setLabel('Done assigning channels').setStyle(ButtonStyle.Primary))];
  }
  if (progress.step === 'output-channel') {
    const menu = new ChannelSelectMenuBuilder().setCustomId('setup:output-channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Choose the channel for this language');
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (progress.step === 'live') {
    const rows = [];
    const targets = settings.targetLanguages.slice(0, 25);
    if (targets.length) {
      const languageMenu = new StringSelectMenuBuilder()
        .setCustomId('setup:live-languages')
        .setPlaceholder('Select languages for the combined live feed')
        .setMinValues(1)
        .setMaxValues(targets.length)
        .addOptions(targets.map(code => ({ label: languageDisplayName(code), value: code, default: settings.liveLanguages.includes(code) })));
      rows.push(new ActionRowBuilder().addComponents(languageMenu));
    }
    const channelMenu = new ChannelSelectMenuBuilder().setCustomId('setup:live-channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Choose the combined live translations channel');
    rows.push(new ActionRowBuilder().addComponents(channelMenu));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:disable-live').setLabel('Disable live translations').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('setup:finish').setLabel('Finish setup').setStyle(ButtonStyle.Success),
    ));
    return rows;
  }
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:restart').setLabel('Restart setup').setStyle(ButtonStyle.Secondary))];
}

function saveSetupStep(guildId, settings, step, extra = {}) {
  settings.setupProgress = { ...(settings.setupProgress || {}), ...extra, step };
  saveGuildLanguageSettings();
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

function joinTranslationChunks(existing, next) {
  const punctuationAtStart = /^[,.;:!?…،。！？；：、]/u.test(next);
  return existing + (punctuationAtStart ? '' : ' ') + next;
}

async function appendTurnMessage(turn, key, channel, prefix, text) {
  const nextText = String(text || '').trim();
  if (!nextText) return null;

  const current = turn.messages.get(key);
  const combinedText = current
    ? joinTranslationChunks(current.text, nextText)
    : nextText;
  const content = prefix + combinedText;

  // Start another message rather than exceeding Discord's message limit.
  if (content.length > 1900) {
    const message = await sendBotMessage(channel, prefix + nextText);
    if (message) turn.messages.set(key, { message, text: nextText });
    return message;
  }

  if (current) {
    try {
      await current.message.edit({ content, allowedMentions: { parse: [] } });
      current.text = combinedText;
      return current.message;
    } catch (err) {
      console.warn('Could not update accumulating translation:', err.message);
      return current.message;
    }
  }
  const message = await sendBotMessage(channel, content);  if (message) turn.messages.set(key, { message, text: nextText });
  return message;
}

async function upsertTurnMessage(turn, key, channel, content) {
  const current = turn.messages.get(key);
  if (current && content.length <= 1900) {
    if (current.content === content) return current.message;
    try {
      await current.message.edit({ content, allowedMentions: { parse: [] } });
      current.content = content;
      return current.message;
    } catch (err) {
      console.warn('Could not update accumulating live translation:', err.message);
      return current.message;
    }
  }

  const message = await sendBotMessage(channel, content);
  if (message) turn.messages.set(key, { message, content });
  return message;
}

async function getGuildTextChannel(guild, channelId) {
  if (!channelId) return null;
  return guild.channels.fetch(channelId).catch(() => null);
}

// -------------------------------------------------------------- Discord ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    const settings = getGuildSettings(guild.id);
    const canPostSetup = candidate => candidate?.isTextBased()
      && candidate.permissionsFor(client.user)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]);
    const channel = canPostSetup(guild.systemChannel)
      ? guild.systemChannel
      : guild.channels.cache.find(canPostSetup);
    if (!channel?.isTextBased()) return;
    const warnings = getSetupWarnings(guild.id, guild);
    const components = warnings.length ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:start').setLabel('Configure server').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:ignore-warnings').setLabel('Ignore these reminders').setStyle(ButtonStyle.Secondary),
    )] : [];
    await channel.send({ content: `Thanks for adding the translation bot!\n\n${setupStatusMessage(guild.id, guild)}\n\nAdmins can run /setup to configure the server.`, components, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`Could not post setup guidance in ${guild.id}:`, err);
  }
});

// -------------------------------------------------------------- commands ---

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inGuild()) return;

  try {
    if (interaction.isButton() && interaction.customId === 'setup:ignore-warnings') {
      if (!hasManageServerPermission(interaction)) return interaction.reply({ content: 'You need the Manage Server permission to change setup reminders.', flags: MessageFlags.Ephemeral });
      const settings = getGuildSettings(interaction.guildId);
      settings.ignoredSetupWarnings = getSetupWarnings(interaction.guildId, interaction.guild).map(item => item.id);
      saveGuildLanguageSettings();
      return interaction.update({ content: `Setup reminders for the current warnings are paused. Run /setup whenever you want to review the configuration again.\n\n${setupStatusMessage(interaction.guildId, interaction.guild)}`, components: [] });
    }
    if (interaction.isButton() && interaction.customId === 'setup:start') {
      if (!hasManageServerPermission(interaction)) return interaction.reply({ content: 'You need the Manage Server permission to configure this server.', flags: MessageFlags.Ephemeral });
      const settings = getGuildSettings(interaction.guildId);
      settings.ignoredSetupWarnings = [];
      settings.setupProgress = { step: 'input' };
      saveGuildLanguageSettings();
      return interaction.update({ content: 'Step 1 of 4: choose the languages members may speak.', components: setupComponents(settings, interaction.guildId) });
    }
    if ((interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isButton()) && interaction.customId.startsWith('setup:')) {
      if (!hasManageServerPermission(interaction)) return interaction.reply({ content: 'You need the Manage Server permission to run server setup.', flags: MessageFlags.Ephemeral });
      const settings = getGuildSettings(interaction.guildId);
      const id = interaction.customId;
      if (id === 'setup:automatic-input') {
        settings.inputLanguages = [];
        saveSetupStep(interaction.guildId, settings, 'input');
        return interaction.update({ content: '**Step 1 of 4 — Spoken languages**\nUnrestricted automatic detection is selected. Whisper can identify supported spoken languages without a server-side language restriction. Press Continue when you are ready for the next step.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:input') {
        settings.inputLanguages = [...interaction.values];
        saveSetupStep(interaction.guildId, settings, 'input');
        return interaction.update({ content: `**Step 1 of 4 — Spoken languages**\nChoose the languages members may speak. Whisper will focus recognition on this list. Your selection is saved automatically; press Continue when you are ready.\nSelected: ${settings.inputLanguages.map(languageDisplayName).join(', ')}`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:continue-input') {
        saveSetupStep(interaction.guildId, settings, 'target');
        return interaction.update({ content: '**Step 2 of 4 — Translation output languages**\nChoose which languages the bot can translate speech into. Select as many as you need, then press Continue. These are the languages used for translated output, not the languages members speak.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:no-targets') {
        settings.targetLanguages = [];
        settings.translationOutputsStatus = 'disabled';
        settings.liveLanguages = [];
        saveSetupStep(interaction.guildId, settings, 'target');
        return interaction.update({ content: '**Step 2 of 4 — Translation output languages**\nTranslation outputs are disabled. Press Continue to skip individual output-channel assignments and configure the combined live feed, or choose languages from the menu to enable translated outputs.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:target') {
        settings.targetLanguages = [...interaction.values];
        settings.translationOutputsStatus = 'configured';
        settings.liveLanguages = settings.liveLanguages.filter(code => settings.targetLanguages.includes(code));
        saveSetupStep(interaction.guildId, settings, 'target');
        return interaction.update({ content: `**Step 2 of 4 — Translation output languages**\nChoose the languages the bot can translate speech into. Your selection is saved automatically; press Continue when ready.\nSelected: ${settings.targetLanguages.map(languageDisplayName).join(', ')}`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:continue-target') {
        if (!settings.targetLanguages.length && settings.translationOutputsStatus !== 'disabled') return interaction.reply({ content: 'Choose at least one translation output language, or use Disable translation outputs.', flags: MessageFlags.Ephemeral });
        saveSetupStep(interaction.guildId, settings, 'outputs');
        return interaction.update({ content: '**Step 3 of 4 — Output channels**\nAssign a Discord text channel for each translation language. Choose a language, then choose its channel. You can leave languages unassigned for now. Press Done assigning channels when finished.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:output-language') {
        saveSetupStep(interaction.guildId, settings, 'output-channel', { outputLanguage: interaction.values[0] });
        return interaction.update({ content: `Choose the text channel for **${languageDisplayName(interaction.values[0])}**:`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:output-channel') {
        const language = settings.setupProgress?.outputLanguage;
        if (!language || !settings.targetLanguages.includes(language)) {
          saveSetupStep(interaction.guildId, settings, 'outputs', { outputLanguage: null });
          return interaction.update({ content: 'That output language is no longer enabled. Choose another language.', components: setupComponents(settings, interaction.guildId) });
        }
        const channel = await getGuildTextChannel(interaction.guild, interaction.values[0]);
        if (!channel) return interaction.update({ content: 'That channel is no longer available. Choose another.', components: setupComponents(settings, interaction.guildId) });
        const perms = channel.permissionsFor(client.user);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return interaction.update({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>. Choose another channel.`, components: setupComponents(settings, interaction.guildId) });
        languageChannels[interaction.guildId] ??= {};
        languageChannels[interaction.guildId][language] = channel.id;
        saveLanguageChannels(interaction.guildId);
        saveSetupStep(interaction.guildId, settings, 'outputs', { outputLanguage: null });
        return interaction.update({ content: `Assigned **${languageDisplayName(language)}** to <#${channel.id}>. Choose another language or continue.`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:outputs-done') {
        saveSetupStep(interaction.guildId, settings, 'live');
        return interaction.update({ content: '**Step 4 of 4 — Combined live translations**\nChoose which enabled translation languages should appear in the shared live feed, then choose its text channel. This selection is independent of the individual language channels. Press Finish setup when everything is ready.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:live-languages') {
        settings.liveLanguages = interaction.values.filter(code => settings.targetLanguages.includes(code));
        saveGuildLanguageSettings();
        return interaction.update({ content: `**Step 4 of 4 — Combined live translations**\nYour live-feed language selection is saved. Choose a text channel for the shared feed, then press Finish setup.\nIncluded languages: ${settings.liveLanguages.map(languageDisplayName).join(', ')}`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:live-channel') {
        const channel = await getGuildTextChannel(interaction.guild, interaction.values[0]);
        if (!channel) return interaction.update({ content: 'That channel is no longer available. Choose another.', components: setupComponents(settings, interaction.guildId) });
        const perms = channel.permissionsFor(client.user);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return interaction.update({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`, components: setupComponents(settings, interaction.guildId) });
        settings.liveChannelId = channel.id;
        settings.liveFeedStatus = 'configured';
        saveGuildLanguageSettings();
        return interaction.update({ content: `Saved the combined live translations channel as <#${channel.id}>. Press Finish setup when you are ready.\n\n${setupSummary(interaction.guildId, interaction.guild)}`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:disable-live') {
        settings.liveChannelId = null;
        settings.liveFeedStatus = 'disabled';
        saveGuildLanguageSettings();
        return interaction.update({ content: `Live translations are disabled. Press Finish setup to save and close the wizard.\n\n${setupSummary(interaction.guildId, interaction.guild)}`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:finish') {
        delete settings.setupProgress;
        saveGuildLanguageSettings();
        return interaction.update({ content: `Setup saved. You can run /setup again to change it.\n\n${setupSummary(interaction.guildId, interaction.guild)}`, components: [] });
      }
      if (id === 'setup:restart') {
        saveSetupStep(interaction.guildId, settings, 'input');
        return interaction.update({ content: 'Step 1 of 4: choose the languages members may speak.', components: setupComponents(settings, interaction.guildId) });
      }
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'language-channel:remove') {
      if (!hasManageServerPermission(interaction)) return interaction.reply({ content: 'You need the Manage Server permission to change these settings.', flags: MessageFlags.Ephemeral });
      const language = interaction.values[0];
      if (!languageChannels[interaction.guildId]?.[language]) return interaction.update({ content: 'That mapping no longer exists.', components: [] });
      delete languageChannels[interaction.guildId][language];
      if (!Object.keys(languageChannels[interaction.guildId]).length) delete languageChannels[interaction.guildId];
      saveLanguageChannels(interaction.guildId);
      return interaction.update({ content: `Removed the output channel mapping for **${languageDisplayName(language)}**.`, components: [] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('language-channel:assign:')) {
      if (!hasManageServerPermission(interaction)) return interaction.reply({ content: 'You need the Manage Server permission to change these settings.', flags: MessageFlags.Ephemeral });
      const channelId = interaction.customId.split(':')[2];
      const channel = await getGuildTextChannel(interaction.guild, channelId);
      const language = interaction.values[0];
      const settings = getGuildSettings(interaction.guildId);
      if (!channel || !settings.targetLanguages.includes(language)) {
        return interaction.update({ content: 'That channel or target language is no longer available. Run /language-channel set again.', components: [] });
      }
      const perms = channel.permissionsFor(client.user);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
        return interaction.update({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`, components: [] });
      }
      languageChannels[interaction.guildId] ??= {};
      languageChannels[interaction.guildId][language] = channel.id;
      saveLanguageChannels(interaction.guildId);
      return interaction.update({ content: `Speech and translations in **${languageDisplayName(language)}** will be posted in <#${channel.id}>.`, components: [] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'user-setup:languages') {
      const settings = getGuildSettings(interaction.guildId);
      const selected = interaction.values.filter(code => settings.inputLanguages.includes(code));
      saveUserLanguagePreferences(interaction.guildId, interaction.user.id, selected);
      return interaction.update({ content: `**Your preferences are saved automatically.**\nSelect all languages you normally speak. The bot uses these as hints when recognizing your speech; press Finish when you are done.\nSelected: ${selected.map(languageDisplayName).join(', ')}`, components: userSetupComponents(settings, selected) });
    }
    if (interaction.isButton() && interaction.customId === 'user-setup:automatic') {
      const settings = getGuildSettings(interaction.guildId);
      saveUserLanguagePreferences(interaction.guildId, interaction.user.id, []);
      return interaction.update({ content: 'Automatic detection is enabled for you and your personal language preferences have been cleared. Press Finish to close setup.', components: userSetupComponents(settings, []) });
    }
    if (interaction.isButton() && interaction.customId === 'user-setup:finish') {
      const selected = getUserLanguagePreferences(interaction.guildId, interaction.user.id);
      return interaction.update({ content: selected.length ? `Setup complete. Your expected spoken languages are: **${selected.map(languageDisplayName).join(', ')}**.` : 'Setup complete. You are using automatic language detection.', components: [] });
    }
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setup') {
      if (!await requireManageServer(interaction)) return;
      const settings = getGuildSettings(interaction.guildId);
      settings.ignoredSetupWarnings = [];
      settings.setupProgress ??= { step: 'input' };
      saveGuildLanguageSettings();
      const step = settings.setupProgress.step;
      const prompts = {
        input: '**Step 1 of 4 — Spoken languages**\nChoose the languages members may speak. Whisper will focus recognition on this list. Select as many as needed; your choices save automatically. Press Continue when ready. Use unrestricted detection if you do not want to limit recognition.',
        target: '**Step 2 of 4 — Translation output languages**\nChoose which languages the bot can translate speech into. These are separate from spoken input languages. Select as many as needed; your choices save automatically. Press Continue when ready.',
        outputs: '**Step 3 of 4 — Output channels**\nAssign a Discord text channel for each translation language. Choose a language, then its channel. You can leave languages unassigned and return later.',
        'output-channel': `Choose the Discord text channel where **${languageDisplayName(settings.setupProgress.outputLanguage)}** translations should be posted.`,
        live: '**Step 4 of 4 — Combined live translations**\nChoose which enabled translation languages appear in the shared live feed, then choose its text channel. This does not change individual language-channel assignments. Press Finish setup when ready.',
      };
      return interaction.reply({ content: `${setupStatusMessage(interaction.guildId, interaction.guild)}\n\n**Server setup wizard**\nSelections are saved automatically. Continue and Finish buttons control when the wizard advances or closes.\n\n${prompts[step] || prompts.input}`, components: [...setupComponents(settings, interaction.guildId), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:ignore-warnings').setLabel('Ignore current reminders').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'user-setup') {
      const settings = getGuildSettings(interaction.guildId);
      if (!settings.inputLanguages.length) return interaction.reply({ content: 'This server uses unrestricted automatic language detection, so member-specific language preferences are unavailable. Ask an admin to enable input languages if you want a restricted language list.', flags: MessageFlags.Ephemeral });
      const selected = getUserLanguagePreferences(interaction.guildId, interaction.user.id).filter(code => settings.inputLanguages.includes(code));
      return interaction.reply({ content: selected.length ? `**Your current expected languages:** ${selected.map(languageDisplayName).join(', ')}\nSelect all languages you normally speak. These preferences help guide speech recognition and are saved automatically. Press Finish when done.` : 'You are currently using automatic detection. Select all languages you normally speak if you want to provide recognition hints. Your choices save automatically; press Finish when done.', components: userSetupComponents(settings, selected), flags: MessageFlags.Ephemeral });
    }

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
    } else if (interaction.commandName === 'translate') {
      await handleTranslateInteraction(interaction, getGuildSettings, SERVICE_URL);
    }
  } catch (err) {
    console.error(err);

    const msg = interaction.commandName === 'translate'
      ? `Translation failed: ${String(err.message || 'unknown error').slice(0, 500)}`
      : 'Something went wrong. Check the bot console.';

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

async function createVoiceSession(guild, voiceChannel, { testRunId = null } = {}) {
  // This project runs tests exclusively; a new test join replaces the current
  // voice connection for this guild. It deliberately does not run /leave cleanup.
  sessions.get(guild.id)?.connection.destroy();

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    throw new Error('Could not connect to the voice channel in time.');
  }

  const session = {
    connection,
    guild,
    testRunId,
    active: new Set(),
    speakerQueues: new Map(),
    workQueue: [],
    runningJobs: 0,
    pendingJobs: 0,
    maxConcurrentJobs: maxConcurrentUtterances,
    outputTail: Promise.resolve(),
    lastStartedSpeakerId: null,
    latestTurnBySpeaker: new Map(),
    activeCaptureBySpeaker: new Map(),
  };

  sessions.set(guild.id, session);

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
    if (sessions.get(guild.id) === session) sessions.delete(guild.id);
  });

  startListening(session);
  logEvent('voice_session_started', {
    runId: testRunId,
    guildId: guild.id,
    channelId: voiceChannel.id,
    channelName: voiceChannel.name,
  });
  return session;
}

async function onJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({
      content: 'Join a voice channel first, then run /join again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await createVoiceSession(interaction.guild, voiceChannel);

  const settings = getGuildSettings(interaction.guildId);
  const liveStatus = settings.liveChannelId
    ? 'The configured live channel will receive selected translations.'
    : 'No live translation channel is configured yet.';

  await interaction.editReply(
    `Listening in **${voiceChannel.name}**. Translations will go to configured language channels. ${liveStatus}`,
  );
}

async function clearBotMessages(guild) {
  const settings = getGuildSettings(guild.id);
  const configuredChannelIds = new Set([
    ...Object.values(languageChannels[guild.id] ?? {}),
    settings.liveChannelId,
  ].filter(Boolean));

  const report = {
    channelsChecked: 0,
    messagesScanned: 0,
    botMessagesFound: 0,
    deletedCount: 0,
    errors: [],
  };

  for (const channelId of configuredChannelIds) {
    let channel;

    try {
      channel = await guild.channels.fetch(channelId);
    } catch (err) {
      const detail = `Could not fetch channel ${channelId}: ${err.message}`;
      console.error(detail);
      report.errors.push(detail);
      continue;
    }

    if (!channel?.isTextBased?.() || !channel.messages) {
      const detail = `Configured channel ${channelId} is missing or is not a supported text channel.`;
      console.warn(detail);
      report.errors.push(detail);
      continue;
    }

    report.channelsChecked++;

    const permissions = channel.permissionsFor(client.user);
    const missingPermissions = [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
      [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
    ]
      .filter(([permission]) => !permissions?.has(permission))
      .map(([, name]) => name);

    if (missingPermissions.length) {
      const detail = `Missing permissions in #${channel.name}: ${missingPermissions.join(', ')}.`;      console.warn(detail);      report.errors.push(detail);
    }

    let before;
    while (true) {
      let page;

      try {
        page = await channel.messages.fetch({
          limit: 100,
          ...(before ? { before } : {}),
        });
      } catch (err) {
        const detail = `Could not read message history in #${channel.name}: ${err.message}`;
        console.error(detail);
        report.errors.push(detail);
        break;
      }

      if (!page.size) break;

      report.messagesScanned += page.size;
      before = page.last().id;

      const botMessages = [...page.values()].filter(
        message => message.author.id === client.user.id,
      );
      report.botMessagesFound += botMessages.length;

      const recent = botMessages.filter(
        message => Date.now() - message.createdTimestamp < 14 * 24 * 60 * 60 * 1000,
      );
      const old = botMessages.filter(
        message => Date.now() - message.createdTimestamp >= 14 * 24 * 60 * 60 * 1000,
      );

      if (recent.length) {
        try {
          const deleted = await channel.bulkDelete(recent, true);
          report.deletedCount += deleted.size;
        } catch (err) {
          const detail = `Bulk delete failed in #${channel.name}: ${err.message}. Trying individual deletes.`;
          console.error(detail);
          report.errors.push(detail);

          for (const message of recent) {
            try {
              await message.delete();
              report.deletedCount++;
            } catch (deleteErr) {
              const failure = `Could not delete message ${message.id} in #${channel.name}: ${deleteErr.message}`;
              console.error(failure);
              report.errors.push(failure);
            }
          }
        }
      }

      for (const message of old) {
        try {
          await message.delete();
          report.deletedCount++;
        } catch (err) {
          const detail = `Could not delete old message ${message.id} in #${channel.name}: ${err.message}`;
          console.error(detail);
          report.errors.push(detail);
        }
      }

      if (page.size < 100) break;
    }
  }

  return report;
}

async function onLeave(interaction) {
  const session = sessions.get(interaction.guildId);

  if (!session) {
    return interaction.reply({
      content: "I'm not in a voice channel.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  session.connection.destroy();
  sessions.delete(interaction.guildId);

  const cleanup = await clearBotMessages(interaction.guild);
  const summary = `Checked ${cleanup.channelsChecked} channel(s), scanned ${cleanup.messagesScanned} message(s), found ${cleanup.botMessagesFound} bot message(s), and deleted ${cleanup.deletedCount}.`;
  const issueSummary = cleanup.errors.length
    ? `\\n\\nSome cleanup steps failed:\\n${cleanup.errors.slice(0, 5).map(error => `• ${error}`).join('\\n')}${cleanup.errors.length > 5 ? `\\n• And ${cleanup.errors.length - 5} more error(s). Check the bot console.` : ''}`
    : '';

  return interaction.editReply(`Left the voice channel. ${summary}${issueSummary}`);
}

// ------------------------------------------------------- language channels ---

async function onLanguageChannel(interaction) {
  if (!await requireManageServer(interaction)) return;

  const action = interaction.options.getSubcommand();

  if (action === 'list') {
    const mapping = languageChannels[interaction.guildId] ?? {};

    const lines = Object.entries(mapping).map(([code, id]) => {
      const channel = interaction.guild.channels.cache.get(id);
      return `• **${languageDisplayName(code)}** (${code}) → ${channel ? `<#${id}>` : `deleted/missing channel (${id})`}`;
    });

    return interaction.reply({
      content: lines.length
        ? `**Language channel mappings**\n${lines.join('\n')}`
        : 'No language channels configured yet. Use `/language-channel set`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    if (!channel.isTextBased() || !channel.guild) {
      return interaction.reply({ content: 'Choose a server text channel.', flags: MessageFlags.Ephemeral });
    }
    const perms = channel.permissionsFor(client.user);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return interaction.reply({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    }
    const targets = getGuildSettings(interaction.guildId).targetLanguages.slice(0, 25);
    if (!targets.length) {
      return interaction.reply({ content: 'Enable at least one server target language first with /language target add.', flags: MessageFlags.Ephemeral });
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`language-channel:assign:${channel.id}`)
      .setPlaceholder('Choose the output language')
      .addOptions(targets.map(code => ({ label: languageDisplayName(code), value: code })));
    return interaction.reply({ content: `Choose which language should be posted in <#${channel.id}>:`, components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

  if (action === 'remove') {
    const mappings = languageChannels[interaction.guildId] || {};
    const codes = Object.keys(mappings);
    if (!codes.length) return interaction.reply({ content: 'There are no output channel mappings to remove.', flags: MessageFlags.Ephemeral });
    const menu = new StringSelectMenuBuilder().setCustomId('language-channel:remove').setPlaceholder('Choose a language mapping to remove').addOptions(codes.slice(0, 25).map(code => ({ label: languageDisplayName(code), value: code })));
    return interaction.reply({ content: 'Choose the output language mapping to remove:', components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
  }

}

// -------------------------------------------------------- language settings ---

async function onLanguage(interaction) {
  if (!await requireManageServer(interaction)) return;

  const group = interaction.options.getSubcommandGroup(true);
  const action = interaction.options.getSubcommand();
  const language = group === 'standard' || action === 'list'
    ? null
    : interaction.options.getString('language', true).toLowerCase();

  const settings = getGuildSettings(interaction.guildId);

  if (group === 'standard') {
    if (action === 'list') {
      return interaction.reply({
        content: `Standard translation pair: **${settings.standardLanguages[0]} ↔ ${settings.standardLanguages[1]}**`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const first = interaction.options.getString('first', true).toLowerCase();
    const second = interaction.options.getString('second', true).toLowerCase();
    if (first === second) {
      return interaction.reply({
        content: 'Choose two different languages for the standard pair.',
        flags: MessageFlags.Ephemeral,
      });
    }

    settings.standardLanguages = [first, second];
    for (const code of settings.standardLanguages) {
      if (!settings.targetLanguages.includes(code)) settings.targetLanguages.push(code);
    }
    settings.translationOutputsStatus = 'configured';
    settings.ignoredSetupWarnings = settings.ignoredSetupWarnings.filter(id => !['target-languages', 'output-channels'].includes(id));
    saveGuildLanguageSettings();
    return interaction.reply({
      content: `Standard pair set to **${first} ↔ ${second}**. Both languages are enabled as translation targets.`,
      flags: MessageFlags.Ephemeral,
    });
  }

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
    if (group === 'target') settings.translationOutputsStatus = 'configured';
    const warningIds = group === 'input' ? ['input-languages'] : group === 'target' ? ['target-languages', 'output-channels'] : [];
    settings.ignoredSetupWarnings = settings.ignoredSetupWarnings.filter(id => !warningIds.includes(id));
    saveGuildLanguageSettings();

    return interaction.reply({
      content: `Added **${language}** to ${group} languages.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'remove') {
    if (group === 'target' && settings.standardLanguages.includes(language)) {
      return interaction.reply({
        content: `**${language}** is part of the standard pair. Change /language standard set before removing it as a target.`,
        flags: MessageFlags.Ephemeral,
      });
    }

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
      settings.translationOutputsStatus = settings.targetLanguages.length ? 'configured' : 'not-configured';
    }
    const warningIds = group === 'input' ? ['input-languages'] : group === 'target' ? ['target-languages', 'output-channels'] : [];
    settings.ignoredSetupWarnings = settings.ignoredSetupWarnings.filter(id => !warningIds.includes(id));

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
    settings.liveFeedStatus = 'disabled';
    settings.ignoredSetupWarnings = settings.ignoredSetupWarnings.filter(id => id !== 'live-channel');
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
    settings.liveFeedStatus = 'configured';
    settings.ignoredSetupWarnings = settings.ignoredSetupWarnings.filter(id => id !== 'live-channel');
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

  receiver.speaking.on('start', async (userId) => {
    const alreadyActive = session.active.has(userId);
    if (alreadyActive) {
      const capture = session.activeCaptureBySpeaker.get(userId);
      if (capture && session.lastStartedSpeakerId !== userId) {
        // Keep the existing capture stream, but associate subsequent emitted
        // segments with a fresh turn after this speaker resumes.
        capture.turn = {
          messages: new Map(),
          liveOriginal: '',
          liveTranslations: new Map(),
        };
        session.latestTurnBySpeaker.set(userId, capture.turn);
        session.lastStartedSpeakerId = userId;
      }
      return;
    }

    session.active.add(userId);
    let capture = null;
    try {
      // Discord bot accounts (music bots, moderation bots, etc.) should never
      // enter speech recognition or translation.
      const member = await session.guild.members.fetch(userId).catch(() => null);
      if (member?.user?.bot && !audioTestSpeakerIds.has(userId)) return;

      // Each capture owns its current turn. If the speaker resumes after an
      // interruption, the active capture's turn is replaced explicitly.
      capture = {
        turn: {
          messages: new Map(),
          liveOriginal: '',
          liveTranslations: new Map(),
        },
      };
      session.activeCaptureBySpeaker.set(userId, capture);
      session.latestTurnBySpeaker.set(userId, capture.turn);
      session.lastStartedSpeakerId = userId;

      await captureUtterance(receiver, userId, (pcm) => {
        const durationMs = pcm.length / BYTES_PER_MS;
        logEvent('audio_segment_captured', {
          runId: session.testRunId,
          guildId: session.guild.id,
          speakerId: userId,
          durationMs: Math.round(durationMs),
          bytes: pcm.length,
        });
        enqueueUtterance(session, userId, pcm, capture.turn);
      });
    } catch (err) {
      console.error(`Capture failed for ${userId}:`, err.message);
    } finally {
      session.active.delete(userId);
      if (session.activeCaptureBySpeaker.get(userId) === capture) {
        session.activeCaptureBySpeaker.delete(userId);
      }
    }
  });
}

function enqueueUtterance(session, userId, pcm, turn) {
  if (!turn) {
    console.error(`Cannot enqueue utterance for ${userId}: missing capture turn.`);
    return;
  }

  const previous = session.speakerQueues.get(userId) ?? Promise.resolve();

  // Reserve output order when audio is captured, not when transcription ends.
  const previousOutput = session.outputTail;
  let releaseOutput;
  session.outputTail = new Promise(resolve => {
    releaseOutput = resolve;
  });

  // Keep each speaker's chunks in order while allowing different speakers
  // to be transcribed concurrently.
  const task = previous
    .catch(() => {})
    .then(() => runWithSessionLimit(
      session,
      () => handleUtterance(session, userId, pcm, turn, previousOutput, releaseOutput),
    ));

  session.speakerQueues.set(userId, task);

  task.catch((err) => {
    console.error(`Utterance failed for ${userId}:`, err);
  }).finally(() => {
    if (session.speakerQueues.get(userId) === task) {
      session.speakerQueues.delete(userId);
    }
  });
}

function runWithSessionLimit(session, job) {
  return new Promise((resolve, reject) => {
    const queuedAt = Date.now();

    session.pendingJobs++;
    session.workQueue.push({ job, resolve, reject, queuedAt });

    const shouldLogQueue = (
      session.pendingJobs === 1 || session.pendingJobs % 5 === 0
    );

    drainSessionQueue(session);

    if (shouldLogQueue) {
      logEvent('utterance_queue_state', {
        runId: session.testRunId,
        guildId: session.guild.id,
        waiting: session.workQueue.length,
        active: session.runningJobs,
        limit: session.maxConcurrentJobs,
        pending: session.pendingJobs,
      });
    }
  });
}

function drainSessionQueue(session) {
  while (
    session.runningJobs < session.maxConcurrentJobs &&
    session.workQueue.length > 0
  ) {
    const item = session.workQueue.shift();
    const queueWaitMs = Date.now() - item.queuedAt;
    session.runningJobs++;

    if (queueWaitMs >= 250) {
      logEvent('utterance_queue_wait', {
        runId: session.testRunId,
        guildId: session.guild.id,
        queueWaitMs,
      });
    }

    Promise.resolve()
      .then(item.job)
      .then(item.resolve, item.reject)
      .finally(() => {
        session.runningJobs--;
        session.pendingJobs--;
        drainSessionQueue(session);
      });
  }
}

function captureUtterance(receiver, userId, onSegment) {
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

    let chunks = [];
    let segmentBytes = 0;
    let settled = false;

    // Look for a low-energy point near the chunk limit. Decoder output is
    // normally delivered in short PCM frames, so boundaries stay frame-aligned.
    const findQuietSplitIndex = () => {
      if (chunks.length < 4 || segmentBytes < segmentMinBytes) return -1;

      const searchStartByte = Math.max(0, segmentBytes - segmentSearchBytes);
      const frameStarts = [];
      let offset = 0;
      for (const frame of chunks) {
        frameStarts.push(offset);
        offset += frame.length;
      }

      let bestRms = Infinity;
      let bestSplit = -1;

      // Score 4 adjacent decoder frames (~80ms at 20ms/frame) and split
      // near the middle of the quietest window in the search region.
      for (let i = 0; i <= chunks.length - 4; i++) {
        const windowStart = frameStarts[i];
        const windowEnd = frameStarts[i + 4];
        if (windowStart < searchStartByte || windowEnd > segmentBytes) continue;

        let sumSquares = 0;
        let samples = 0;
        for (let j = i; j < i + 4; j++) {
          const frame = chunks[j];
          for (let k = 0; k + 1 < frame.length; k += 2) {
            const sample = frame.readInt16LE(k);
            sumSquares += sample * sample;
            samples++;
          }
        }

        if (samples === 0) continue;
        const rms = Math.sqrt(sumSquares / samples);
        if (rms < bestRms) {
          bestRms = rms;
          bestSplit = i + 2;
        }
      }

      return bestRms <= segmentQuietRms ? bestSplit : -1;
    };

    const emitSegment = (frameCount = chunks.length) => {
      if (frameCount <= 0) return;

      const segmentFrames = chunks.splice(0, frameCount);
      const emittedBytes = segmentFrames.reduce((total, frame) => total + frame.length, 0);
      const pcm = Buffer.concat(segmentFrames, emittedBytes);
      segmentBytes -= emittedBytes;

      if (pcm.length >= minUtteranceBytes) {
        onSegment(pcm);
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      emitSegment();
      resolve();
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    decoder.on('data', (chunk) => {
      chunks.push(chunk);
      segmentBytes += chunk.length;

      if (segmentBytes >= maxUtteranceBytes) {
        const quietSplit = findQuietSplitIndex();
        // Fall back to the hard maximum when no sufficiently quiet boundary
        // exists, so continuous speech can never hold a chunk indefinitely.
        emitSegment(quietSplit > 0 ? quietSplit : chunks.length);
      }
    });

    decoder.on('end', finish);
    decoder.on('error', fail);
    opusStream.on('error', fail);

    opusStream.pipe(decoder);
  });
}

// ------------------------------------------------------------- the work ----

async function handleUtterance(session, userId, pcm, turn, previousOutput, releaseOutput) {
  const utteranceStartedAt = Date.now();
  try {
    const durationMs = pcm.length / BYTES_PER_MS;
    logEvent('utterance_processing_started', {
      runId: session.testRunId,
      guildId: session.guild.id,
      speakerId: userId,
      durationMs: Math.round(durationMs),
    });
    if (durationMs < minMs) return;

    const member = await session.guild.members.fetch(userId).catch(() => null);
    const name = member?.displayName ?? 'Unknown';
    const wav = pcmToWav(pcm, SAMPLE_RATE, CHANNELS);

    if (recordWav) {
      const file = path.join(dataDir, 'recordings', `${Date.now()}-${userId}.wav`);
      fs.writeFileSync(file, wav);
      console.log(`Saved ${file} (${(durationMs / 1000).toFixed(1)} s)`);
    }

    const settings = getGuildSettings(session.guild.id);
    let result;

    try {
      const params = new URLSearchParams({
        speaker: userId,
        candidates: settings.inputLanguages.join(','),
        expected_languages: getUserLanguagePreferences(session.guild.id, userId)
          .filter(language => settings.inputLanguages.includes(language)).join(','),
        language_hint: turn.detectedLanguage || '',
        targets: settings.targetLanguages.join(','),
        translate: settings.targetLanguages.length > 0 ? 'true' : 'false',
      });

      const serviceStartedAt = Date.now();
      const res = await fetch(`${SERVICE_URL}/process?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) throw new Error(`service answered HTTP ${res.status}`);
      result = await res.json();
      logEvent('processing_service_completed', {
        runId: session.testRunId,
        guildId: session.guild.id,
        speakerId: userId,
        durationMs: Date.now() - serviceStartedAt,
        sourceLanguage: result.language || null,
        translationCount: Object.keys(result.translations || {}).length,
        hasOriginal: Boolean(result.original),
      });
      // All segments emitted from the same captured speech turn share this
      // language decision. A fresh turn object resets the hint automatically.
      if (!turn.detectedLanguage && result.language) {
        turn.detectedLanguage = result.language;
      }
    } catch (err) {
      logEvent('processing_service_failed', {
        runId: session.testRunId,
        guildId: session.guild.id,
        speakerId: userId,
        error: String(err.message || 'unknown error').slice(0, 300),
      });
      console.error('Could not reach the Python service:', err.message);
      return;
    }

    if (!result.original) {
      logEvent('utterance_empty_result', {
        runId: session.testRunId,
        guildId: session.guild.id,
        speakerId: userId,
        totalDurationMs: Date.now() - utteranceStartedAt,
      });
      return;
    }

    // Only publication waits for earlier captured chunks. Speech recognition
    // and translation requests still run concurrently.
    await previousOutput;

    const sourceLanguage = result.language;
    const translations = result.translations ?? {};
    const sourceChannelId = sourceLanguage
      && getLanguageChannelId(session.guild.id, sourceLanguage);

    let sourceMessageId = '';
    if (sourceChannelId) {
      const sourceChannel = await getGuildTextChannel(session.guild, sourceChannelId);
      if (sourceChannel) {
        const sentMessage = await appendTurnMessage(
          turn,
          `source:${sourceLanguage}:${sourceChannelId}`,
          sourceChannel,
          `**${languageFlag(sourceLanguage)} ${escapeMarkdown(name)}:** `,
          escapeMarkdown(result.original),
        );
        sourceMessageId = sentMessage?.id || '';
      }
    }

    broadcastOverlayMessage({
      language: sourceLanguage,
      channelName: sourceLanguage.toUpperCase(),
      flag: languageFlag(sourceLanguage),
      author: name,
      content: result.original,
      messageId: sourceMessageId,
    });

    for (const [targetLanguage, translatedText] of Object.entries(translations)) {
      if (!translatedText) continue;
      if (!settings.targetLanguages.includes(targetLanguage)) continue;

      const targetChannelId = getLanguageChannelId(session.guild.id, targetLanguage);
      let targetMessageId = '';
      if (targetChannelId) {
        const targetChannel = await getGuildTextChannel(session.guild, targetChannelId);
        if (targetChannel) {
          const sentMessage = await appendTurnMessage(
            turn,
            `target:${targetLanguage}:${targetChannelId}`,
            targetChannel,
            `**${languageFlag(targetLanguage)} ${escapeMarkdown(name)}:** `,
            escapeMarkdown(translatedText),
          );
          targetMessageId = sentMessage?.id || '';
        }
      }

      broadcastOverlayMessage({
        language: targetLanguage,
        channelName: targetLanguage.toUpperCase(),
        flag: languageFlag(targetLanguage),
        author: name,
        content: translatedText,
        messageId: targetMessageId,
      });
    }

    if (settings.liveChannelId) {
      const liveChannel = await getGuildTextChannel(session.guild, settings.liveChannelId);
      if (liveChannel) {
        turn.liveOriginal = turn.liveOriginal
          ? joinTranslationChunks(turn.liveOriginal, escapeMarkdown(result.original))
          : escapeMarkdown(result.original);

        for (const language of settings.liveLanguages) {
          if (!settings.targetLanguages.includes(language)) continue;
          const translatedText = translations[language];
          if (!translatedText) continue;
          const previousText = turn.liveTranslations.get(language) || '';
          turn.liveTranslations.set(
            language,
            previousText
              ? joinTranslationChunks(previousText, escapeMarkdown(translatedText))
              : escapeMarkdown(translatedText),
          );
        }

        const liveBlocks = settings.liveLanguages
          .filter(language => settings.targetLanguages.includes(language))
          .map(language => {
            const translatedText = turn.liveTranslations.get(language);
            if (!translatedText) return null;
            const label = `${languageFlag(language)} ${language.toUpperCase()}`;
            return `**${label}**\n${translatedText}`;
          })
          .filter(Boolean);

        const originalLabel = sourceLanguage
          ? `${languageFlag(sourceLanguage)} ${sourceLanguage.toUpperCase()} · Original`
          : '🌐 Original';
        const liveMessage = [
          `**${escapeMarkdown(name)}**\n**${originalLabel}**\n${turn.liveOriginal}`,
          ...liveBlocks,
        ].join('\n\n') + '\n\n\u200B';

        await upsertTurnMessage(
          turn,
          `live:${settings.liveChannelId}`,
          liveChannel,
          liveMessage,
        );
      }
    }
  } finally {
    logEvent('utterance_processing_finished', {
      runId: session.testRunId,
      guildId: session.guild.id,
      speakerId: userId,
      totalDurationMs: Date.now() - utteranceStartedAt,
    });
    // Failed or empty requests must not block later chunks in the output queue.
    releaseOutput();
  }
}
// ------------------------------------------------------ audio test control ---

function startAudioTestControl() {
  if (AUDIO_TEST_CONTROL_ENABLED !== 'true') return;
  const controlPort = Number(AUDIO_TEST_CONTROL_PORT);
  if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535) {
    throw new Error('AUDIO_TEST_CONTROL_PORT must be an integer between 1024 and 65535.');
  }
  if (!AUDIO_TEST_CONTROL_TOKEN || AUDIO_TEST_CONTROL_TOKEN.length < 32) {
    throw new Error('AUDIO_TEST_CONTROL_TOKEN must be set to a value of at least 32 characters when audio test control is enabled.');
  }

  const expectedToken = Buffer.from(AUDIO_TEST_CONTROL_TOKEN);
  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };

    const supplied = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) {
      return send(401, { error: 'Unauthorized' });
    }

    if (req.method !== 'POST' || !['/join', '/leave', '/status'].includes(req.url)) {
      return send(404, { error: 'Not found' });
    }

    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) return send(413, { error: 'Request too large' });
      }
      const body = raw ? JSON.parse(raw) : {};

      if (!client.isReady()) return send(503, { error: 'Discord client is not ready' });
      const guildId = String(body.guildId || '');
      if (!/^\d{17,20}$/.test(guildId)) return send(400, { error: 'A valid guildId is required' });

      if (req.url === '/status') {
        const session = sessions.get(guildId);
        return send(200, session ? {
          ok: true,
          joined: true,
          runId: session.testRunId,
          activeSpeakers: session.active.size,
          queuedSpeakers: session.speakerQueues.size,
          pendingJobs: session.pendingJobs,
          runningJobs: session.runningJobs,
          waitingJobs: session.workQueue.length,
        } : { ok: true, joined: false });
      }

      if (req.url === '/leave') {
        const session = sessions.get(guildId);
        if (!session) return send(200, { ok: true, joined: false, cleanup: null });
        const runId = session.testRunId;
        session.connection.destroy();
        sessions.delete(guildId);
        const cleanup = await clearBotMessages(session.guild);
        logEvent('audio_test_session_stopped', {
          runId,
          guildId,
          deletedMessages: cleanup.deletedCount,
          cleanupErrors: cleanup.errors.length,
        });
        return send(200, { ok: true, joined: false, cleanup: {
          channelsChecked: cleanup.channelsChecked,
          messagesScanned: cleanup.messagesScanned,
          deletedCount: cleanup.deletedCount,
          errors: cleanup.errors.length,
        } });
      }

      const channelId = String(body.channelId || '');
      if (!/^\d{17,20}$/.test(channelId)) return send(400, { error: 'A valid channelId is required' });
      const guild = await client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
        return send(400, { error: 'channelId must identify a voice or stage channel in the selected guild' });
      }

      const me = guild.members.me || await guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.Connect)) {
        return send(403, { error: 'The translator bot does not have Connect permission in that channel' });
      }

      const runId = String(body.runId || '');
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(runId)) {
        return send(400, { error: 'A valid runId is required' });
      }
      await createVoiceSession(guild, channel, { testRunId: runId });
      logEvent('audio_test_session_started', { runId, guildId, channelId, channelName: channel.name });
      return send(200, { ok: true, joined: true, runId, guildId, channelId, channelName: channel.name });
    } catch (error) {
      console.error('[AUDIO TEST CONTROL]', error);
      return send(500, { error: String(error.message || 'Internal error').slice(0, 300) });
    }
  });

  server.listen(controlPort, '127.0.0.1', () => {
    logEvent('audio_test_control_ready', { host: '127.0.0.1', port: controlPort });
  });
  server.on('error', error => console.error('[AUDIO TEST CONTROL] Server error:', error));
  return server;
}

const audioTestControlServer = startAudioTestControl();

// -------------------------------------------------------------- shutdown ---

process.on('SIGINT', () => {
  for (const session of sessions.values()) {
    session.connection.destroy();
  }

  audioTestControlServer?.close();
  stopOverlayRelay();
  client.destroy();
  process.exit(0);
});

await client.login(DISCORD_TOKEN);