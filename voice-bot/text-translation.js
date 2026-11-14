import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MessageFlags, escapeMarkdown } from 'discord.js';

const historyFile = fileURLToPath(new URL('./translation-history.json', import.meta.url));
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
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2) + '\n');
}

function languageName(code) {
  const names = { en: 'English', es: 'Spanish', no: 'Norwegian', nn: 'Norwegian Nynorsk',
    sv: 'Swedish', da: 'Danish', de: 'German', fr: 'French', it: 'Italian',
    pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian',
    tr: 'Turkish', ar: 'Arabic', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
  return names[code] || code.toUpperCase();
}

async function translateText(text, target, pair, serviceUrl) {
  const response = await fetch(`${serviceUrl}/translate-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, target: target || null, pair }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`translation service returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function defaultPair(settings) {
  const pair = settings.standardLanguages;
  return Array.isArray(pair) && pair.length === 2 ? pair : ['en', 'es'];
}

function outputContent(author, original, translated, source, target) {
  return [
    `**${escapeMarkdown(author)} · Original (${languageName(source)})**`,
    escapeMarkdown(original),
    '',
    `**Translation (${languageName(target)})**`,
    escapeMarkdown(translated),
  ].join('\n').slice(0, 1950);
}

export async function handleTranslateInteraction(interaction, getGuildSettings, serviceUrl) {
  const subcommand = interaction.options.getSubcommand();
  const settings = getGuildSettings(interaction.guildId);
  const pair = defaultPair(settings);

  if (subcommand === 'text') {
    const text = interaction.options.getString('text', true).trim();
    const requestedTarget = interaction.options.getString('language');
    if (requestedTarget && !settings.targetLanguages.includes(requestedTarget)) {
      return interaction.reply({
        content: `The server has not enabled ${languageName(requestedTarget)} as a target. Ask an admin to use /language target add.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();
    const result = await translateText(text, requestedTarget, pair, serviceUrl);
    if (!result.translation) throw new Error('The translation service did not return a translation. Check that TRANSLATOR is configured.');
    const posted = await interaction.channel.send({
      content: outputContent(interaction.user.username, text, result.translation, result.source, result.target),
      allowedMentions: { parse: [] },
    });
    return interaction.editReply(`Posted the ${languageName(result.source)} → ${languageName(result.target)} translation: ${posted.url}`);
  }

  if (subcommand === 'recent') {
    const count = interaction.options.getInteger('count') ?? 1;
    const requestedTarget = interaction.options.getString('language');
    if (requestedTarget && !settings.targetLanguages.includes(requestedTarget)) {
      return interaction.reply({
        content: `The server has not enabled ${languageName(requestedTarget)} as a target. Ask an admin to use /language target add.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!interaction.channel?.messages) {
      return interaction.reply({ content: 'This command needs a normal text channel.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channelId = interaction.channelId;
    history[channelId] ??= [];
    const records = history[channelId];
    const byId = new Map(records.map(record => [record.id, record]));

    // Fetch enough recent history to cover the requested number, including
    // messages already translated and deleted (kept in the local archive).
    let before;
    let scanned = 0;
    while (scanned < 500 && records.filter(record => !record.deletedAt).length < count + 30) {
      const page = await interaction.channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!page.size) break;
      scanned += page.size;
      before = page.last().id;
      for (const message of page.values()) {
        if (message.author.bot || !message.content?.trim() || message.content.startsWith('/')) continue;
        if (byId.has(message.id)) continue;
        const record = {
          id: message.id,
          author: message.member?.displayName || message.author.username,
          content: message.content,
          timestamp: message.createdTimestamp,
          translatedTargets: [],
          deletedAt: null,
        };
        records.push(record);
        byId.set(record.id, record);
      }
      if (page.size < 100) break;
    }

    records.sort((a, b) => a.timestamp - b.timestamp);
    const candidates = records.filter(record => {
      if (!record.content?.trim()) return false;
      if (requestedTarget) return !record.translatedTargets.includes(requestedTarget);
      return true;
    }).slice(-Math.min(count, 50));

    if (!candidates.length) {
      return interaction.editReply('No eligible untranslated messages were found.');
    }

    let postedCount = 0;
    let failedCount = 0;
    for (const record of candidates) {
      try {
        const result = await translateText(record.content, requestedTarget, pair, serviceUrl);
        if (!result.translation) throw new Error('Empty translation result');

        const target = result.target;
        if (record.translatedTargets.includes(target)) continue;

        const posted = await interaction.channel.send({
          content: outputContent(record.author, record.content, result.translation, result.source, target),
          allowedMentions: { parse: [] },
        });

        record.translatedTargets.push(target);
        record.lastTranslationMessageId = posted.id;
        saveHistory();

        if (!record.deletedAt) {
          const original = await interaction.channel.messages.fetch(record.id).catch(() => null);
          if (original) {
            await original.delete();
            record.deletedAt = Date.now();
            saveHistory();
          }
        }
        postedCount++;
      } catch (err) {
        failedCount++;
        console.error(`Recent-message translation failed for ${record.id}:`, err);
      }
    }

    // Keep a bounded archive per channel; preserve the most recent records.
    if (records.length > MAX_HISTORY_PER_CHANNEL) {
      history[channelId] = records.slice(-MAX_HISTORY_PER_CHANNEL);
      saveHistory();
    }

    return interaction.editReply(
      `Translated and posted ${postedCount} message(s) in chronological order.${failedCount ? ` ${failedCount} failed; their originals were left untouched.` : ''}`,
    );
  }
}
