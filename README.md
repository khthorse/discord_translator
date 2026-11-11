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

The voice bot processes utterances from different speakers concurrently while keeping each
speaker's messages in order. The Python service separately limits simultaneous Whisper jobs
to avoid overloading the GPU.

- `MAX_CONCURRENT_UTTERANCES=3` controls active utterance pipelines per server.
- `MAX_CONCURRENT_TRANSCRIPTIONS=2` controls simultaneous Whisper inference jobs.
- If GPU memory usage or transcription time gets worse under load, lower
  `MAX_CONCURRENT_TRANSCRIPTIONS` to `1`. Increase only after measuring under real traffic.

The bot logs its pending/active utterance counts. The Python service logs queue wait,
transcription, translation, and total processing times. Compare those timings while testing
with one, two, and three speakers before changing the concurrency values.

## Choosing a translator
- `TRANSLATOR=google` + `GOOGLE_API_KEY`
- `TRANSLATOR=openai` + `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
  - local Ollama: `LLM_BASE_URL=http://localhost:11434/v1`, `LLM_MODEL=<model you pulled>`, `LLM_API_KEY=ollama`

## Privacy
The bot processes everyone's voice in the channel. Tell your friends. Audio is kept in memory only and
never written to disk unless you turn on `RECORD_WAV`.
