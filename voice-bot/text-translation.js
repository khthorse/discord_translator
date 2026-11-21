import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, MessageFlags, escapeMarkdown } from 'discord.js';

const dataDir = process.env.DATA_DIR || fileURLToPath(new URL('.', import.meta.url));
fs.mkdirSync(dataDir, { recursive: true });
const historyFile = path.join(dataDir, 'translation-history.json');
const MAX_HISTORY_PER_CHANNEL = 2000;

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read translation history:', err);
    return {};
  }
}
let history = loadHistory();

function saveHistory() {
  const temporaryFile = `${historyFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(history, null, 2) + '\n');
  fs.renameSync(temporaryFile, historyFile);
}

const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', no: 'Norwegian Bokmål', nn: 'Norwegian Nynorsk',
  sv: 'Swedish', da: 'Danish', fi: 'Finnish', de: 'German', fr: 'French',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
  uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
};
const languageName = code => LANGUAGE_NAMES[code] || String(code).toUpperCase();

async function requestTranslation(text, target, pair, serviceUrl) {
  const response = await fetch(`${serviceUrl}/translate-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target: target || null, pair }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    let detail = await response.text();
    try { detail = JSON.parse(detail).detail || detail; } catch {}
    throw new Error(String(detail).slice(0, 500));
  }
  return response.json();
}

function renderRecord(record) {
  const parts = [
    `**${escapeMarkdown(record.author)} · Original (${languageName(record.source)})**`,
    escapeMarkdown(record.content),
  ];
  for (const [target, translated] of Object.entries(record.translations || {})) {
    parts.push('', `**Translation (${languageName(target)})**`, escapeMarkdown(translated));
  }
  const rendered = parts.join('\n');
  if (rendered.length > 1950) throw new Error('This message and its translation exceed Discord’s safe message length; the original was left in place.');
  return rendered;
}

function ensureRecord(channelRecords, message) {
  let record = channelRecords.find(item => item.id === message.id);
  if (!record) {
    record = {
      id: message.id,
      author: message.member?.displayName || message.author.globalName || message.author.username,
      content: message.content,
      timestamp: message.createdTimestamp,
      source: null,
      translations: {},
      outputMessageId: null,
      deletedAt: null,
    };
    channelRecords.push(record);
  }
  return record;
}

export async function handleTranslateInteraction(interaction, getGuildSettings, serviceUrl) {
  const settings = getGuildSettings(interaction.guildId);
  const pair = settings.standardLanguages?.length === 2
    ? settings.standardLanguages
    : ['en', 'es'];
  const subcommand = interaction.options.getSubcommand();
  const requestedTarget = interaction.options.getString('language');

  if (requestedTarget && !settings.targetLanguages.includes(requestedTarget)) {
    return interaction.reply({
      content: `The server has not enabled ${languageName(requestedTarget)} as a target. Ask an admin to use /language target add.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (subcommand === 'text') {
    const text = interaction.options.getString('text', true).trim();
    await interaction.deferReply();
    const result = await requestTranslation(text, requestedTarget, pair, serviceUrl);
    if (!result.translation) throw new Error('The translation backend returned an empty result.');
    const output = [
      `**${escapeMarkdown(interaction.user.globalName || interaction.user.username)} · Original (${languageName(result.source)})**`,
      escapeMarkdown(text),
      '',
      `**Translation (${languageName(result.target)})**`,
      escapeMarkdown(result.translation),
    ].join('\n');
    if (output.length > 1950) {
      throw new Error('That text and its translation are too long for one Discord post. Try a shorter text.');
    }
    return interaction.editReply({ content: output, allowedMentions: { parse: [] } });
  }

  if (subcommand !== 'recent') return;

  const count = interaction.options.getInteger('count') ?? 1;
  const channel = interaction.channel;
  if (!channel?.messages || !channel.isTextBased?.()) {
    return interaction.reply({ content: 'This command needs a server text channel.', flags: MessageFlags.Ephemeral });
  }

  const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  const missing = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
  ].filter(([flag]) => !permissions?.has(flag)).map(([, label]) => label);
  if (missing.length) {
    return interaction.reply({
      content: `I need these permissions in this channel: ${missing.join(', ')}.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const canDelete = permissions.has(PermissionFlagsBits.ManageMessages);

  await interaction.deferReply();
  const channelRecords = history[channel.id] ?? [];
  history[channel.id] = channelRecords;

  // Read recent human messages. The durable archive also contains messages
  // removed after earlier successful translations.
  let before;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    before = page.last().id;
    for (const message of page.values()) {
      if (message.author.bot || !message.content?.trim()) continue;
      if (message.content.startsWith('/') || message.content.startsWith('!')) continue;
      ensureRecord(channelRecords, message);
    }
    if (page.size < 100) break;
  }

  channelRecords.sort((a, b) => b.timestamp - a.timestamp);
  const pending = [];
  const translationErrors = [];
  for (const record of channelRecords) {
    if (pending.length >= count) break;
    if (!record.content?.trim()) continue;
    if (requestedTarget && record.translations?.[requestedTarget]) continue;
    if (!requestedTarget && record.source) {
      const knownTarget = record.source === pair[0]
        ? pair[1]
        : record.source === pair[1]
          ? pair[0]
          : null;
      if (knownTarget && record.translations?.[knownTarget]) continue;
    }
    try {
      // Detect source and resolve the standard-pair direction for records
      // that have not yet been translated to this target.
      const result = await requestTranslation(record.content, requestedTarget, pair, serviceUrl);
      if (!result.translation || record.translations?.[result.target]) continue;
      pending.push({ record, result });
    } catch (err) {
      translationErrors.push(err.message || 'Unknown translation error');
      console.error(`Recent translation failed for message ${record.id}:`, err);
    }
  }

  // Keep all translation posts in original-message chronological order.
  // Discord cannot move an existing message, so reuse the existing bot-post
  // positions: edit those posts to contain the earliest records, then append
  // only the remaining records. This avoids deleting/reposting the whole archive.
  const pendingById = new Map();
  for (const { record, result } of pending) {
    pendingById.set(record.id, {
      ...record,
      source: result.source,
      translations: {
        ...(record.translations || {}),
        [result.target]: result.translation,
      },
    });
  }

  const desiredRecords = channelRecords
    .map(record => pendingById.get(record.id) || record)
    .filter(record => Object.keys(record.translations || {}).length > 0)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

  const outputIds = [...new Set(
    channelRecords.map(record => record.outputMessageId).filter(Boolean),
  )];
  const outputSlots = [];
  for (const id of outputIds) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) outputSlots.push(message);
  }
  // These messages already occupy their positions in the channel. Reassign
  // their contents from oldest to newest, then create any additional posts.
  outputSlots.sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp || a.id.localeCompare(b.id),
  );

  const newSlots = [];
  try {
    for (let i = outputSlots.length; i < desiredRecords.length; i++) {
      newSlots.push(await channel.send({
        content: renderRecord(desiredRecords[i]),
        allowedMentions: { parse: [] },
      }));
    }
  } catch (err) {
    for (const message of newSlots) {
      await message.delete().catch(deleteError =>
        console.error('Could not clean up a partially posted translation:', deleteError),
      );
    }
    console.error('Could not create the reordered translation posts:', err);
    return interaction.editReply(
      'Could not publish the reordered translations. Originals were left unchanged; please try again.',
    );
  }

  const editedSlots = [];
  try {
    for (let i = 0; i < Math.min(outputSlots.length, desiredRecords.length); i++) {
      const message = outputSlots[i];
      const rendered = renderRecord(desiredRecords[i]);
      if (message.content === rendered) continue;

      editedSlots.push({ message, previousContent: message.content });
      await message.edit({
        content: rendered,
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    for (const edit of editedSlots.reverse()) {
      await edit.message.edit({
        content: edit.previousContent,
        allowedMentions: { parse: [] },
      }).catch(rollbackError =>
        console.error('Could not roll back a translation post edit:', rollbackError),
      );
    }
    for (const message of newSlots) {
      await message.delete().catch(deleteError =>
        console.error('Could not clean up a partially posted translation:', deleteError),
      );
    }
    console.error('Could not reorder the existing translation posts:', err);
    return interaction.editReply(
      'Could not reorder the translation posts. Originals were left unchanged; please try again.',
    );
  }

  // If the archive contains fewer records than existing bot posts, remove
  // the surplus posts only after all replacement content has been published.
  for (const message of outputSlots.slice(desiredRecords.length)) {
    await message.delete().catch(err =>
      console.error('Could not delete a surplus translation post:', err),
    );
  }

  // Persist the new record-to-post mapping after every desired post exists.
  const selected = [];
  for (let i = 0; i < desiredRecords.length; i++) {
    const slot = i < outputSlots.length
      ? outputSlots[i]
      : newSlots[i - outputSlots.length];
    const record = channelRecords.find(item => item.id === desiredRecords[i].id);
    Object.assign(record, desiredRecords[i], { outputMessageId: slot.id });
  }
  for (const { record } of pending) {
    const savedRecord = channelRecords.find(item => item.id === record.id);
    if (savedRecord) selected.push(savedRecord);
  }
  saveHistory();

  // Delete originals only after the complete reordered set is safely posted.
  let deletionFailures = 0;
  if (canDelete) {
    for (const record of selected) {
      if (record.deletedAt) continue;
      const original = await channel.messages.fetch(record.id).catch(() => null);
      if (original) {
        try {
          await original.delete();
          record.deletedAt = Date.now();
        } catch (deleteError) {
          deletionFailures++;
          console.error('Could not delete original ' + record.id + ':', deleteError);
        }
      } else {
        record.deletedAt = Date.now();
      }
    }
  }
  saveHistory();
  if (channelRecords.length > MAX_HISTORY_PER_CHANNEL) {
    history[channel.id] = channelRecords.slice(-MAX_HISTORY_PER_CHANNEL);
  }
  saveHistory();

  const deletionNote = !canDelete
    ? ' I could not remove originals because I need Manage Messages permission.'
    : deletionFailures
      ? ` ${deletionFailures} original message(s) could not be deleted; check the bot's channel permissions.`
      : ' Originals were removed after their replacement was posted.';
  if (!selected.length && translationErrors.length) {
    return interaction.editReply(
      `Could not translate any messages. ${String(translationErrors[0]).slice(0, 400)} Originals were left unchanged.`,
    );
  }

  return interaction.editReply(
    selected.length
      ? `Posted ${selected.length} translation(s) in chronological order.${deletionNote}${translationErrors.length ? ` ${translationErrors.length} message(s) could not be translated.` : ''}`
      : 'No eligible untranslated messages were found. Originals were left unchanged.',
  );
}
