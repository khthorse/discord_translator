# Discord voice translator (Spanish <-> English)

```
voice-bot/   JavaScript. Joins voice, captures each speaker, posts subtitles in a text channel.
service/     Python. Audio in -> faster-whisper -> translator -> text out.
```

## Requirements
- Node.js 22.12 or newer
- Python 3.11 or 3.12 (newer versions may lack wheels for some dependencies)
- NVIDIA driver + CUDA 12 / cuDNN 9 libraries for GPU Whisper (or set `WHISPER_DEVICE=cpu`)

## 1. Create the Discord bot
1. https://discord.com/developers/applications -> New Application.
2. Bot tab -> Reset Token -> copy it into `.env` as `DISCORD_TOKEN`. No privileged intents are needed.
3. General Information -> copy the Application ID into `.env` as `DISCORD_CLIENT_ID`.
4. Discord: User Settings -> Advanced -> Developer Mode on. Right-click your server -> Copy Server ID -> `DISCORD_GUILD_ID`.
5. OAuth2 -> URL Generator -> scopes `bot` + `applications.commands`; permissions: View Channels, Send Messages, Connect.
   Open the generated URL to invite the bot.

## 2. Configure
Copy `.env.example` to `.env` and fill in the three Discord values. Leave `TRANSLATOR=none` for the first transcription test. To actually translate English/Spanish, choose `google` with a Google API key or `openai` with a working OpenAI-compatible endpoint.

## 3. Start the Python service
```
cd service
python -m venv .venv
.venv\Scripts\activate          (Linux/macOS: source .venv/bin/activate)
pip install -r requirements.txt
python main.py
```
The first start downloads the Whisper model (about 1.5 GB).
GPU libraries on Windows: if it complains about cublas/cudnn, run
`pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` (check the faster-whisper README for the exact
versions it currently needs). `main.py` adds those DLL folders automatically.

## 4. Start the bot
```
cd voice-bot
npm install
npm run register      (once)
npm start
```
In Discord, create `#english`, `#español`, and `#live-translations`. Give the bot View Channel + Send Messages in all three channels. Then, as a server admin, configure:
```
/language-channel set language:en channel:#english
/language-channel set language:es channel:#español
```
Run `/join` in `#live-translations` after joining a voice channel. `/leave` disconnects the bot.

The two language rooms receive speech in that language, whether it was spoken originally or translated from the other language. `#live-translations` keeps the combined format: translation first, original underneath. Language mappings are saved in `voice-bot/language-channels.json` and survive bot restarts.

To add another language room later, use `/language-channel set` with its language code and text channel. `/language-channel list` shows mappings; `/language-channel remove` removes one. These commands require the Discord **Manage Server** permission.

Bot subtitle messages are automatically deleted after `MESSAGE_DELETE_SECONDS` (default 300 seconds / 5 minutes). Set it to `0` to disable. Only messages sent by the bot are scheduled for deletion; user messages are never touched. Pending deletion timers are in memory, so a bot restart cancels timers for messages already sent.

## First test (no translation)
Set `RECORD_WAV=true` and `TRANSLATOR=none`, talk, and check:
1. `voice-bot/recordings/*.wav` sound right (proves capture and decryption work),
2. the Python console prints what Whisper heard,
3. the transcript shows up in the text channel.
Then switch `RECORD_WAV` back to `false`.

## Live processing and latency

The voice bot processes audio chunks from different speakers concurrently while keeping each
speaker's chunks in order. During continuous speech, it emits a chunk every `MAX_UTTERANCE_MS`
without ending the Discord audio stream; the final shorter chunk is flushed after silence.
The Python service separately limits simultaneous Whisper jobs to avoid overloading the GPU.

- `MAX_CONCURRENT_UTTERANCES=3` controls active audio-chunk pipelines per server.
- `SILENCE_MS=700` ends a speaker's capture after 700ms of silence.
- `MIN_UTTERANCE_MS=500` ignores chunks shorter than 500ms.
- `MAX_UTTERANCE_MS=8000` sets the hard maximum chunk duration during continuous speech.
  The bot searches near the end of each chunk for a quieter boundary before splitting.
- `SEGMENT_SEARCH_MS=1200` sets how far back from the hard limit it searches.
- `SEGMENT_MIN_MS=4000` prevents very short chunks from being emitted by quiet-boundary
  detection.
- `SEGMENT_QUIET_RMS=700` sets the 16-bit PCM RMS threshold used to recognize a quiet
  window. If no suitable quiet point is found, the bot falls back to the hard maximum.
- `MAX_CONCURRENT_TRANSCRIPTIONS=2` controls simultaneous Whisper inference jobs.
- `MAX_CONCURRENT_TRANSLATIONS=2` controls how many target languages are translated at once.
  Extra targets wait for a worker; this makes adding languages possible without launching
  an unlimited number of requests at once.
- Start with both values at `2` on a local GPU. If Ollama generation slows down or GPU
  memory pressure increases, reduce translation concurrency to `1` and compare timings.

The bot logs its pending/active utterance counts. The Python service logs queue wait,
transcription, translation, and total processing times. Compare those timings while testing
with one, two, and three speakers before changing the concurrency values.

## Choosing a translator
- `TRANSLATOR=google` + `GOOGLE_API_KEY`
- `TRANSLATOR=openai` + `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
  - local Ollama: `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=<model you pulled>`, `LLM_API_KEY=ollama`

## Optional overlay relay (friends can use the overlay without Discord RPC)

The overlay keeps its original Discord RPC reader. In its settings, choose one of:
- **Discord** — existing Discord desktop IPC/RPC connection (default).
- **Relay** — receives live transcripts directly from the PC running the voice bot. Friends do not need Discord RPC credentials.
- **Both** — listens to both sources and suppresses duplicates when both carry the same Discord message ID.

The relay is optional. Without `OVERLAY_RELAY_TOKENS`, the bot disables it and the existing Discord channel posting continues normally.

### Host setup

1. Copy `.env.example` to `.env` as usual.
2. Generate one random token per person (run once for each person):
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Add the credentials to the host's private `.env` file. Use unique labels and never commit or post these values:
   ```env
   OVERLAY_RELAY_PORT=8765
   OVERLAY_RELAY_TOKENS=owner:YOUR_64_CHARACTER_TOKEN,friend1:THEIR_64_CHARACTER_TOKEN
   ```
4. Start the voice bot. It listens only on `127.0.0.1:8765`; it is not exposed directly to the internet.
5. To test from outside your PC, install Cloudflare Tunnel and run a Quick Tunnel:
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8765
   ```
   Use the generated HTTPS hostname as a WebSocket URL by changing `https://` to `wss://` and adding `/overlay`, for example `wss://YOUR-HOST.trycloudflare.com/overlay`.
   Keep the tunnel terminal running while friends connect. A Quick Tunnel hostname is temporary and can change when restarted.

### Friend setup

1. Open overlay settings and choose **Relay**.
2. Paste the `wss://.../overlay` URL and that friend's personal token.
3. Save. The overlay encrypts the token with Windows secure storage; it is not displayed again.
4. Select the languages they want to display as usual.

### Revoking access

Remove that person's `label:token` entry from `OVERLAY_RELAY_TOKENS` in the host's `.env`, then restart the voice bot. Their token will no longer authenticate. Give each person a different token; do not reuse one shared credential.

The relay forwards only transcript text and display metadata, not voice audio. The local health endpoint is `http://127.0.0.1:8765/health`. For remote use, always use the secure `wss://` URL; the overlay permits plain `ws://` only for loopback testing.


## Privacy
The bot processes everyone's voice in the channel. Tell your friends. Audio is kept in memory only and
never written to disk unless you turn on `RECORD_WAV`.
