
import './env.js';
import fs from 'node:fs';
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

const dataDir = process.env.DATA_DIR || fileURLToPath(new URL('.', import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });

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
  const menu = new StringSelectMenuBuilder()
    .setCustomId('user-setup:languages')
    .setPlaceholder('Choose the languages you speak')
    .setMinValues(1)
    .setMaxValues(allowed.length)
    .addOptions(allowed.map(code => ({ label: languageDisplayName(code), value: code, default: selected.includes(code) })));
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId('user-setup:automatic')
      .setLabel('Use automatic detection')
      .setStyle(ButtonStyle.Secondary)),
  ];
}



function setupSummary(guildId) {
  const settings = getGuildSettings(guildId);
  const mappings = languageChannels[guildId] || {};
  const outputLines = settings.targetLanguages.map(code =>
    `• ${languageDisplayName(code)}: ${mappings[code] ? `<#${mappings[code]}>` : settings.ignoredSetupWarnings.includes('output-channels') ? 'ignored for now' : 'not assigned'}`,
  );
  return [
    '**Server setup summary**',
    `Input languages: ${settings.inputLanguages.length ? settings.inputLanguages.map(languageDisplayName).join(', ') : 'none'}`,
    `Output languages: ${settings.targetLanguages.length ? settings.targetLanguages.map(languageDisplayName).join(', ') : settings.translationOutputsStatus === 'disabled' ? 'disabled intentionally' : 'none / not configured'}`,
    ...outputLines,
    `Live translations: ${settings.liveChannelId ? `<#${settings.liveChannelId}>` : settings.liveFeedStatus === 'disabled' ? 'disabled intentionally' : settings.ignoredSetupWarnings.includes('live-channel') ? 'ignored for now' : 'not configured'}`,
  ].join('\n');
}


function getSetupWarnings(guildId) {
  const settings = getGuildSettings(guildId);
  const mappings = languageChannels[guildId] || {};
  const warnings = [];
  if (!settings.inputLanguages.length) warnings.push({ id: 'input-languages', text: 'No input languages are restricted; Whisper will use automatic language detection.' });
  const missingOutputs = settings.targetLanguages.filter(code => !mappings[code]);
  if (missingOutputs.length) warnings.push({ id: 'output-channels', text: `No output channel assigned for: ${missingOutputs.map(languageDisplayName).join(', ')}.` });
  if (!settings.targetLanguages.length && settings.translationOutputsStatus !== 'disabled') warnings.push({ id: 'target-languages', text: 'No translation output languages are enabled.' });
  if (!settings.liveChannelId && settings.liveFeedStatus !== 'disabled') warnings.push({ id: 'live-channel', text: 'The combined live translations channel is not configured.' });
  return warnings.filter(item => !settings.ignoredSetupWarnings.includes(item.id));
}

function setupStatusMessage(guildId) {
  const warnings = getSetupWarnings(guildId);
  const status = setupSummary(guildId);
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
    if (isInput) rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:automatic-input').setLabel('Use unrestricted automatic detection').setStyle(ButtonStyle.Secondary)));
    if (!isInput) rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:no-targets').setLabel('Disable translation outputs').setStyle(ButtonStyle.Secondary)));
    return rows;
  }
  if (progress.step === 'outputs') {
    const targets = settings.targetLanguages.slice(0, 25);
    if (!targets.length) return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:finish').setLabel('Finish without output channels').setStyle(ButtonStyle.Secondary))];
    const menu = new StringSelectMenuBuilder().setCustomId('setup:output-language').setPlaceholder('Choose an output language to assign').addOptions(targets.map(code => ({ label: languageDisplayName(code), value: code })));
    return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:outputs-done').setLabel('Done assigning channels').setStyle(ButtonStyle.Secondary))];
  }
  if (progress.step === 'output-channel') {
    const menu = new ChannelSelectMenuBuilder().setCustomId('setup:output-channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Choose the channel for this language');
    return [new ActionRowBuilder().addComponents(menu)];
  }
  if (progress.step === 'live') {
    const menu = new ChannelSelectMenuBuilder().setCustomId('setup:live-channel').setChannelTypes(ChannelType.GuildText).setPlaceholder('Choose the combined live translations channel');
    return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:disable-live').setLabel('Disable live translations').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('setup:finish').setLabel('Finish setup').setStyle(ButtonStyle.Success))];
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

  const message = await sendBotMessage(channel, content);
  if (message) turn.messages.set(key, { message, text: nextText });
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
    const channel = guild.systemChannel || guild.channels.cache.find(candidate =>
      candidate.isTextBased() && candidate.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    );
    if (!channel?.isTextBased()) return;
    const warnings = getSetupWarnings(guild.id);
    const components = warnings.length ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:start').setLabel('Configure server').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:ignore-warnings').setLabel('Ignore these reminders').setStyle(ButtonStyle.Secondary),
    )] : [];
    await channel.send({ content: `Thanks for adding the translation bot!\n\n${setupStatusMessage(guild.id)}\n\nAdmins can run /setup to configure the server.`, components, allowedMentions: { parse: [] } });
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
      settings.ignoredSetupWarnings = getSetupWarnings(interaction.guildId).map(item => item.id);
      saveGuildLanguageSettings();
      return interaction.update({ content: `Setup reminders for the current warnings are paused. Run /setup whenever you want to review the configuration again.\n\n${setupStatusMessage(interaction.guildId)}`, components: [] });
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
        saveSetupStep(interaction.guildId, settings, 'target');
        return interaction.update({ content: 'Automatic language detection is enabled for the server. Step 2 of 4: choose translation output languages.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:input') {
        settings.inputLanguages = [...interaction.values];
        saveSetupStep(interaction.guildId, settings, 'target');
        return interaction.update({ content: 'Step 2 of 4: choose the languages the bot should translate into.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:no-targets') {
        settings.targetLanguages = [];
        settings.translationOutputsStatus = 'disabled';
        settings.liveLanguages = [];
        saveSetupStep(interaction.guildId, settings, 'outputs');
        return interaction.update({ content: 'Translation outputs are disabled. Continue to the live-feed step or finish setup.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:target') {
        settings.targetLanguages = [...interaction.values];
        settings.translationOutputsStatus = 'configured';
        settings.liveLanguages = settings.liveLanguages.filter(code => settings.targetLanguages.includes(code));
        saveSetupStep(interaction.guildId, settings, 'outputs');
        return interaction.update({ content: 'Step 3 of 4: assign an output channel to each language. Choose a language, then choose its channel. You can leave any language unassigned for now.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:output-language') {
        saveSetupStep(interaction.guildId, settings, 'output-channel', { outputLanguage: interaction.values[0] });
        return interaction.update({ content: `Choose the text channel for **${languageDisplayName(interaction.values[0])}**:`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:output-channel') {
        const language = settings.setupProgress?.outputLanguage;
        const channel = await getGuildTextChannel(interaction.guild, interaction.values[0]);
        if (!language || !settings.targetLanguages.includes(language) || !channel) return interaction.update({ content: 'That language or channel is no longer available. Please choose again.', components: setupComponents(settings, interaction.guildId) });
        const perms = channel.permissionsFor(client.user);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return interaction.update({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>. Choose another channel.`, components: setupComponents(settings, interaction.guildId) });
        languageChannels[interaction.guildId] ??= {};
        languageChannels[interaction.guildId][language] = channel.id;
        saveLanguageChannels();
        saveSetupStep(interaction.guildId, settings, 'outputs', { outputLanguage: null });
        return interaction.update({ content: `Assigned **${languageDisplayName(language)}** to <#${channel.id}>. Choose another language or continue.`, components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:outputs-done') {
        saveSetupStep(interaction.guildId, settings, 'live');
        return interaction.update({ content: 'Step 4 of 4: choose the combined live translations channel, or disable the live feed.', components: setupComponents(settings, interaction.guildId) });
      }
      if (id === 'setup:live-channel') {
        const channel = await getGuildTextChannel(interaction.guild, interaction.values[0]);
        if (!channel) return interaction.update({ content: 'That channel is no longer available. Choose another.', components: setupComponents(settings, interaction.guildId) });
        const perms = channel.permissionsFor(client.user);
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return interaction.update({ content: `I need View Channel + Send Messages permissions in <#${channel.id}>.`, components: setupComponents(settings, interaction.guildId) });
        settings.liveChannelId = channel.id;
        settings.liveFeedStatus = 'configured';
        saveGuildLanguageSettings();
        delete settings.setupProgress;
        saveGuildLanguageSettings();
        return interaction.update({ content: `Setup complete!\n\n${setupSummary(interaction.guildId)}`, components: [] });
      }
      if (id === 'setup:disable-live') {
        settings.liveChannelId = null;
        settings.liveFeedStatus = 'disabled';
        delete settings.setupProgress;
        saveGuildLanguageSettings();
        return interaction.update({ content: `Setup complete. Live translations are disabled.\n\n${setupSummary(interaction.guildId)}`, components: [] });
      }
      if (id === 'setup:finish') {
        delete settings.setupProgress;
        saveGuildLanguageSettings();
        return interaction.update({ content: `Setup saved. You can run /setup again to change it.\n\n${setupSummary(interaction.guildId)}`, components: [] });
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
      saveLanguageChannels();
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
      saveLanguageChannels();
      return interaction.update({ content: `Speech and translations in **${languageDisplayName(language)}** will be posted in <#${channel.id}>.`, components: [] });
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'user-setup:languages') {
      const settings = getGuildSettings(interaction.guildId);
      const selected = interaction.values.filter(code => settings.inputLanguages.includes(code));
      saveUserLanguagePreferences(interaction.guildId, interaction.user.id, selected);
      return interaction.update({ content: `Your expected spoken languages are now: **${selected.map(languageDisplayName).join(', ')}**.`, components: userSetupComponents(settings, selected) });
    }
    if (interaction.isButton() && interaction.customId === 'user-setup:automatic') {
      saveUserLanguagePreferences(interaction.guildId, interaction.user.id, []);
      return interaction.update({ content: 'Automatic language detection is enabled for you. Your personal preferences have been cleared.', components: [] });
    }
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'setup') {
      if (!await requireManageServer(interaction)) return;
      const settings = getGuildSettings(interaction.guildId);
      settings.ignoredSetupWarnings = [];
      settings.setupProgress ??= { step: 'input' };
      saveGuildLanguageSettings();
      const step = settings.setupProgress.step;
      const prompt = step === 'input' ? 'Step 1 of 4: choose the languages members may speak.'
        : step === 'target' ? 'Step 2 of 4: choose the translation output languages.'
          : step === 'outputs' ? 'Step 3 of 4: assign output channels. Choose a language, then its channel.'
            : step === 'output-channel' ? `Choose the channel for **${languageDisplayName(settings.setupProgress.outputLanguage)}**.`
              : 'Step 4 of 4: choose the combined live translations channel, or disable the live feed.';
      return interaction.reply({ content: `${setupStatusMessage(interaction.guildId)}\n\nServer setup wizard (progress is saved automatically).\n${prompt}`, components: [...setupComponents(settings, interaction.guildId), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:ignore-warnings').setLabel('Ignore current reminders').setStyle(ButtonStyle.Secondary))], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === 'user-setup') {
      const settings = getGuildSettings(interaction.guildId);
      if (!settings.inputLanguages.length) return interaction.reply({ content: 'This server has not enabled any input languages yet. Ask a server admin to configure them with /language input add.', flags: MessageFlags.Ephemeral });
      const selected = getUserLanguagePreferences(interaction.guildId, interaction.user.id).filter(code => settings.inputLanguages.includes(code));
      return interaction.reply({ content: selected.length ? `Your current expected languages: **${selected.map(languageDisplayName).join(', ')}**. Select the languages you normally speak.` : 'You are currently using automatic detection. Select the languages you normally speak; you can choose more than one.', components: userSetupComponents(settings, selected), flags: MessageFlags.Ephemeral });
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
    speakerQueues: new Map(),
    workQueue: [],
    runningJobs: 0,
    pendingJobs: 0,
    maxConcurrentJobs: maxConcurrentUtterances,
    outputTail: Promise.resolve(),
    lastStartedSpeakerId: null,
    latestTurnBySpeaker: new Map(),
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
      const detail = `Missing permissions in #${channel.name}: ${missingPermissions.join(', ')}.`;
      console.warn(detail);
      report.errors.push(detail);
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
      return `• **${code}** → ${channel ? `<#${id}>` : `deleted/missing channel (${id})`}`;
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
      if (session.lastStartedSpeakerId !== userId) {
        session.latestTurnBySpeaker.set(userId, {
          messages: new Map(),
          liveOriginal: '',
          liveTranslations: new Map(),
        });
        session.lastStartedSpeakerId = userId;
      }
      return;
    }

    session.active.add(userId);
    try {
      // Discord bot accounts (music bots, moderation bots, etc.) should never
      // enter speech recognition or translation.
      const member = await session.guild.members.fetch(userId).catch(() => null);
      if (member?.user?.bot) return;

      // A new speaker turn gets its own accumulating messages. A speaker who
      // resumes after an interruption gets a new turn even if their old stream
      // has not reached its silence timeout yet.
      session.latestTurnBySpeaker.set(userId, {
        messages: new Map(),
        liveOriginal: '',
        liveTranslations: new Map(),
      });
      session.lastStartedSpeakerId = userId;

      await captureUtterance(receiver, userId, (pcm) => {
        enqueueUtterance(session, userId, pcm);
      });
    } catch (err) {
      console.error(`Capture failed for ${userId}:`, err.message);
    } finally {
      session.active.delete(userId);
    }
  });
}

function enqueueUtterance(session, userId, pcm) {
  const turn = session.latestTurnBySpeaker.get(userId) ?? {
    messages: new Map(),
    liveOriginal: '',
    liveTranslations: new Map(),
  };
  session.latestTurnBySpeaker.set(userId, turn);
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
      console.log(
        `[QUEUE] ${session.workQueue.length} waiting; ` +
        `${session.runningJobs}/${session.maxConcurrentJobs} active; ` +
        `${session.pendingJobs} total.`,
      );
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
      console.log(`[QUEUE] Waited ${queueWaitMs}ms before processing an utterance.`);
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
  try {
    const durationMs = pcm.length / BYTES_PER_MS;
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

      const res = await fetch(`${SERVICE_URL}/process?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) throw new Error(`service answered HTTP ${res.status}`);
      result = await res.json();
      // All segments emitted from the same captured speech turn share this
      // language decision. A fresh turn object resets the hint automatically.
      if (!turn.detectedLanguage && result.language) {
        turn.detectedLanguage = result.language;
      }
    } catch (err) {
      console.error('Could not reach the Python service:', err.message);
      return;
    }

    if (!result.original) return;

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
    // Failed or empty requests must not block later chunks in the output queue.
    releaseOutput();
  }
}
// -------------------------------------------------------------- shutdown ---

process.on('SIGINT', () => {
  for (const session of sessions.values()) {
    session.connection.destroy();
  }

  stopOverlayRelay();
  client.destroy();
  process.exit(0);
});

await client.login(DISCORD_TOKEN);
