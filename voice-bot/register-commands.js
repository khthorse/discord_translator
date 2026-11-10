// Run once (and again whenever you change the commands):

import './env.js';
import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
  console.error('Set DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID in .env first.');
  process.exit(1);
}

const LANGUAGE_CHOICES = [
  ['English', 'en'],
  ['Spanish', 'es'],
  ['Norwegian Bokmål', 'no'],
  ['Norwegian Nynorsk', 'nn'],
  ['Swedish', 'sv'],
  ['Danish', 'da'],
  ['Finnish', 'fi'],
  ['German', 'de'],
  ['French', 'fr'],
  ['Italian', 'it'],
  ['Portuguese', 'pt'],
  ['Dutch', 'nl'],
  ['Polish', 'pl'],
  ['Russian', 'ru'],
  ['Ukrainian', 'uk'],
  ['Turkish', 'tr'],
  ['Arabic', 'ar'],
  ['Japanese', 'ja'],
  ['Korean', 'ko'],
  ['Chinese', 'zh'],
].map(([name, code]) => ({ name, value: code }));

function addLanguageOption(subcommand, description) {
  return subcommand.addStringOption(option =>
    option
      .setName('language')
      .setDescription(description)
      .setRequired(true)
      .addChoices(...LANGUAGE_CHOICES));
}

function addLanguageGroup(command, groupName, description, actionDescriptions) {
  return command.addSubcommandGroup(group => {
    group.setName(groupName).setDescription(description);

    for (const [action, actionDescription] of Object.entries(actionDescriptions)) {
      const sub = group.addSubcommand(s =>
        s.setName(action).setDescription(actionDescription));

      if (action !== 'list') {
        addLanguageOption(sub, 'Choose a language');
      }
    }

    return group;
  });
}

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and listen for speech')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel')
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('language')
    .setDescription('Configure translation languages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(group =>
      group
        .setName('input')
        .setDescription('Configure languages Whisper can recognize')
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Language to allow as speech input');
          return sub.setName('add').setDescription('Allow a spoken language');
        })
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Language to stop recognizing');
          return sub.setName('remove').setDescription('Remove a spoken language');
        })
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List allowed input languages')))
    .addSubcommandGroup(group =>
      group
        .setName('target')
        .setDescription('Configure languages TranslateGemma translates into')
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Language to translate into');
          return sub.setName('add').setDescription('Enable a translation target');
        })
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Translation target to disable');
          return sub.setName('remove').setDescription('Disable a translation target');
        })
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List translation targets')))
    .addSubcommandGroup(group =>
      group
        .setName('live')
        .setDescription('Configure languages in the combined live feed')
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Language to include in the live feed');
          return sub.setName('add').setDescription('Include a language');
        })
        .addSubcommand(sub => {
          addLanguageOption(sub, 'Language to remove from the live feed');
          return sub.setName('remove').setDescription('Remove a language');
        })
        .addSubcommand(sub =>
          sub.setName('list').setDescription('List live-feed languages')))
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('live-channel')
    .setDescription('Configure the combined live translations channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Choose the combined live translations channel')
      .addChannelOption(option => option
        .setName('channel')
        .setDescription('Channel for combined translations')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Disable the combined live feed'))
    .addSubcommand(sub => sub
      .setName('show')
      .setDescription('Show the configured live channel'))
    .setContexts(InteractionContextType.Guild),

  new SlashCommandBuilder()
    .setName('language-channel')
    .setDescription('Configure a text channel for a language')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set the channel for a language code')
      .addStringOption(option => option
        .setName('language')
        .setDescription('Language code, e.g. en or es')
        .setRequired(true))
      .addChannelOption(option => option
        .setName('channel')
        .setDescription('Text channel for this language')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('remove')
      .setDescription('Remove a language channel mapping')
      .addStringOption(option => option
        .setName('language')
        .setDescription('Language code to remove, e.g. en')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List configured language channels'))
    .setContexts(InteractionContextType.Guild),
].map(command => command.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
  { body: commands },
);

console.log(`Registered ${commands.length} commands.`);
