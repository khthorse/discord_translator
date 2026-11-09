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

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your voice channel and post subtitles in this text channel')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel')
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
].map(c => c.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);
await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
console.log(`Registered ${commands.length} commands.`);
