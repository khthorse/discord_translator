// Run once (and again whenever you change the commands): npm run register
import './env.js';
import { InteractionContextType, REST, Routes, SlashCommandBuilder } from 'discord.js';

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
].map((c) => c.toJSON());

const rest = new REST().setToken(DISCORD_TOKEN);

// Guild commands appear instantly. Global commands can take up to an hour.
await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
  body: commands,
});
console.log(`Registered ${commands.length} commands.`);
