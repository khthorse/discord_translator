# Wookie Translator — Privacy Notice

**Version:** 1.0  
**Effective date:** 19 November 2026

This notice describes the data flows built into Wookie Translator. What is processed and where it is sent depends on how the host and each overlay user configure the software.

## 1. Audio and speech processing

The Discord voice bot captures audio from the configured Discord voice channel and sends it to the configured speech-recognition service. In the standard self-hosted setup, that service runs on the host computer. Audio is processed in memory by default and is not written to WAV files unless the host deliberately enables `RECORD_WAV=true`.

Speech recognition produces transcript text. Depending on the selected translation backend, transcript text may be sent to a locally hosted model or to a third-party translation service configured by the host.

## 2. Discord messages

The bot may publish original transcripts and translations to the Discord text channels configured by the server administrator. Discord handles those messages under its own terms and privacy policy.

The bot also keeps local translation metadata in `voice-bot/translation-history.json`. Bot messages may be automatically deleted according to the host's configuration. The bot's cleanup command deletes messages authored by the bot in its configured output channels; it does not delete user-authored messages.

## 3. Overlay and relay

The desktop overlay receives subtitle text and related display metadata through either Discord desktop RPC, the host's authenticated relay, or both, depending on the user's settings.

When relay mode is used, the host's relay forwards transcript text and display metadata to authenticated overlay clients. The relay does not forward voice audio. The host controls who can connect by issuing and revoking individual relay tokens.

The overlay stores its connection settings locally. Relay tokens and Discord application credentials are protected using the operating system's secure storage when that facility is available.

## 4. Third-party services

Depending on configuration, Wookie Translator may communicate with Discord, a translation provider, Ollama or another OpenAI-compatible service, and a tunnel provider such as Cloudflare. Those providers process data according to their own terms and privacy policies. Review those policies before enabling a service.

## 5. Data retention and control

The host controls the machine running the bot, speech service, translation backend and relay. The host is responsible for securing those systems, their logs, configuration files and any optional recordings.

Users should ask the host how long transcripts and related Discord messages are retained. Do not enable audio recording unless it is necessary and appropriate.

## 6. Voice-channel notice and consent

Before enabling the bot in a voice channel, tell participants that audio may be captured for transcription and translation. Obtain any consent required by applicable law, Discord rules and the community's policies.

## 7. Children's privacy

Do not use Wookie Translator to collect or share personal information about children without the permissions and safeguards required by applicable law.

## 8. Changes and contact

This notice may be updated as the software changes. For privacy questions, use the Issues page of the Wookie Translator repository:

https://github.com/khthorse/discord_translator/issues

This notice is a project description, not legal advice. The operator of each self-hosted installation is responsible for its own legal compliance.
