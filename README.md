# Discord Voice Translator

A Discord bot that listens to human speakers in a voice channel, transcribes speech with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper), translates it, and publishes
the results to public Discord text channels. The repository also includes an optional
desktop subtitle overlay.

## Project licence and privacy

Wookie Translator's original application and project code are proprietary. The software
is offered free of charge for personal, non-commercial use under the terms in
[`LICENSE`](LICENSE) and [`EULA.md`](EULA.md). Do not assume that making this repository
public grants permission to redistribute, modify or commercially use the project.

See [`PRIVACY.md`](PRIVACY.md) for an overview of audio, transcript, relay and third-party
service data flows. The operator of each self-hosted installation is responsible for
providing appropriate notice and obtaining any required permissions or consent.

## What is included

- **`service/`** — Python FastAPI service for speech recognition and text/audio translation.
- **`voice-bot/`** — Discord.js bot that captures voice audio, sends it to the Python service,
  and posts public results.
- **`overlay/`** — Optional Electron desktop overlay. It can read messages through Discord
  desktop RPC or receive them through the bot's authenticated relay.

The default language pair is English (`en`) and Spanish (`es`). Server admins can change
the language configuration with slash commands.

## Requirements

- Windows 10/11 (the commands below use PowerShell).
- Node.js **22.12 or newer**.
- Python **3.11** recommended (64-bit).
- Git.
- A Discord application and bot account.
- For GPU Whisper: a supported NVIDIA GPU and a current NVIDIA driver. The Python
  requirements install the pinned CUDA 12 runtime/cuDNN packages used by this project.
- For local LLM translation: [Ollama](https://ollama.com/) and a model already pulled.
- Optional overlay: Discord desktop app. For remote overlay relay connections, install
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

## 1. Get the project

Open PowerShell and clone the repository, or update an existing clone:

```powershell
git clone https://github.com/khthorse/discord_translator.git
cd discord_translator
```

If you already have the project:

```powershell
cd C:\path\to\discord_translator
git pull
```

Use the branch you intend to run if it is not the repository's default branch.

## 2. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Open **Bot**, create/reset the bot token, and copy it. Keep it private.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**. The bot uses this
   for `/translate recent`.
4. Under **General Information**, copy the **Application ID**.
5. In Discord, enable **Developer Mode** under User Settings → Advanced, then right-click
   your server and copy its **Server ID**.
6. Under **OAuth2 → URL Generator**, select the `bot` and `applications.commands` scopes.
   Grant the bot these permissions:
   - View Channels
   - Send Messages
   - Read Message History
   - Manage Messages
   - Connect
   - Speak
7. Open the generated invite URL and add the bot to your server.

The bot needs View Channel and Send Messages in each output channel. It also needs Connect
and Speak for the voice channel. Read Message History and Manage Messages are used by
`/translate recent` and the `/leave` cleanup.

## 3. Configure the shared environment file

Both the Python service and the Discord bot load one **project-root** file named `.env`.
Create it beside this README (not inside `service/` or `voice-bot/`).

Example for local Ollama translation:

```env
# Discord bot (required)
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
DISCORD_CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
DISCORD_GUILD_ID=YOUR_DISCORD_SERVER_ID

# Python service
SERVICE_URL=http://127.0.0.1:8000
SERVICE_HOST=127.0.0.1
SERVICE_PORT=8000

# Whisper: defaults to NVIDIA GPU
WHISPER_MODEL=large-v3-turbo
WHISPER_DEVICE=cuda
WHISPER_COMPUTE=float16
WHISPER_BEAM_SIZE=1

# Translation: none, google, or openai
TRANSLATOR=openai
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=YOUR_OLLAMA_MODEL_NAME

# Voice bot tuning (these are also the built-in defaults)
MAX_CONCURRENT_UTTERANCES=3
SILENCE_MS=500
MIN_UTTERANCE_MS=500
MAX_UTTERANCE_MS=4000
SEGMENT_SEARCH_MS=1200
SEGMENT_MIN_MS=2500
SEGMENT_QUIET_RMS=700
SHOW_ORIGINAL=true
RECORD_WAV=false
MESSAGE_DELETE_SECONDS=300

# Optional overlay relay (leave empty to disable it)
# OVERLAY_RELAY_PORT=8765
# OVERLAY_RELAY_TOKENS=owner:YOUR_64_CHARACTER_TOKEN
```

Do not add quotes around ordinary values. Never commit or share `.env`: it contains bot
credentials and possibly API keys. The repository's `.gitignore` excludes it.

### Choose a translation backend

Set exactly one backend using `TRANSLATOR`:

- **Transcription only:** `TRANSLATOR=none`. Whisper recognizes speech, but no translated
  text is produced. This is a good first test.
- **Google Cloud Translation:** `TRANSLATOR=google` and set `GOOGLE_API_KEY=...`.
- **Ollama or another supported OpenAI-compatible service:** `TRANSLATOR=openai`,
  `LLM_MODEL=...`, and `LLM_BASE_URL=...`. This project currently sends requests to
  the Ollama-style `/api/chat` endpoint. For local Ollama, the default base URL is
  `http://localhost:11434` (do not append `/v1`).

For Ollama, start the Ollama application/service and make sure the model named by
`LLM_MODEL` has been downloaded before starting the Python service. For example, use
`ollama pull YOUR_MODEL_NAME` in a separate terminal.

## 4. Set up and start the Python service

Open a PowerShell window at the project root:

```powershell
cd service
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python main.py
```

Keep this window open. On first start, faster-whisper downloads the selected model if it
is not already cached. The default model is `large-v3-turbo`.

If PowerShell blocks activation, run this once in that PowerShell window and retry activation:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

You should see a startup message similar to:

```text
Loading Whisper model 'large-v3-turbo' on cuda (float16)...
Translator: OpenAICompatTranslator
Uvicorn running on http://127.0.0.1:8000
```

Check that the service responds by opening **http://127.0.0.1:8000/health** in a browser.
The health endpoint reports the loaded model, translator, and concurrency settings.

### Optional: run Whisper on the CPU instead

The service supports CPU Whisper without changing application code. In the root `.env`,
change:

```env
WHISPER_DEVICE=cpu
WHISPER_COMPUTE=int8
```

Restart the Python service for the setting to take effect. To return to the GPU defaults:

```env
WHISPER_DEVICE=cuda
WHISPER_COMPUTE=float16
```

Ollama is configured separately through `LLM_BASE_URL` and `LLM_MODEL`; changing the
Whisper device does not move Ollama off its configured device. Compare timings under the
same workload before deciding which setup is faster on your hardware.

## 5. Install and start the Discord bot

Open a **second** PowerShell window at the project root:

```powershell
cd voice-bot
npm install
npm run register
npm start
```

Run `npm run register` once after configuring the Discord IDs, and again whenever slash
commands are changed. It registers the commands for the server specified by
`DISCORD_GUILD_ID`. Keep this terminal open while using the bot.

The bot and Python service must both be running. The bot sends audio to
`SERVICE_URL`, which defaults to `http://127.0.0.1:8000`.

## 6. Configure Discord channels and start translating

Create the text channels you want to use. For example:

- `#english` — English speech and English translations.
- `#español` — Spanish speech and Spanish translations.
- `#live-translations` — combined live feed.

As a server admin, map language codes to their public output channels:

```text
/language-channel set language:en channel:#english
/language-channel set language:es channel:#español
/live-channel set channel:#live-translations
```

Join a Discord voice channel, then run `/join` in a server text channel. The bot joins your
voice channel and starts listening. Run `/leave` when finished.

### How live voice output works

- Speech is recognized from human members. **Bot accounts are ignored** and are not sent
  through speech recognition or translation.
- The language-specific channels receive speech in that language, whether it was spoken
  originally or translated from another enabled input language.
- The combined live channel shows the selected translations, with the translation first
  and the original underneath.
- Audio chunks from the same speaking turn are accumulated into the turn's message rather
  than creating a separate Discord message for every chunk. A new speaker turn gets a new
  message; different speakers' turns are published in capture order.
- Long turns may continue in another Discord message to stay within Discord's message-size
  limit.

The default input, target, standard-pair, and live languages are English and Spanish.
Server admins can change them with the commands below.

## 7. Language and channel commands

These configuration commands require the Discord **Manage Server** permission.

| Command | Purpose |
|---|---|
| `/language standard set first:en second:es` | Set the bidirectional default pair used by text translation. |
| `/language standard list` | Show the standard pair. |
| `/language input list` | List languages Whisper is allowed to recognize. |
| `/language input add language:no` | Add a recognized input language. |
| `/language input remove language:no` | Remove an input language. At least one must remain. |
| `/language target list` | List translation targets. |
| `/language target add language:de` | Add a translation target. |
| `/language target remove language:de` | Remove a target (the standard pair cannot be removed until the pair is changed). |
| `/language live list` | List languages included in the combined live feed. |
| `/language live add language:de` | Include an enabled target language in the live feed. |
| `/language live remove language:de` | Remove a language from the live feed. |
| `/language-channel list` | Show language-to-channel mappings. |
| `/language-channel set language:en channel:#english` | Set the public channel for a language. |
| `/language-channel remove language:en` | Remove a language channel mapping. |
| `/live-channel show` | Show the combined live channel. |
| `/live-channel set channel:#live-translations` | Set the combined live channel. |
| `/live-channel remove` | Disable the combined live feed. |

A language must be enabled as a target before it can be added to the combined live feed.
Changing the standard pair also enables both languages as translation targets.

## 8. Text and recent-message translation

The bot also provides public text translation commands:

- `/translate text text:Hello there` — translate using the standard pair and publish
  the original and translation in the channel.
- `/translate text text:Hello there language:de` — explicitly choose a target language.
- `/translate recent` — translate the newest eligible human-authored message in the
  current channel.
- `/translate recent count:5` — translate up to five eligible messages, publishing
  results oldest-first.
- `/translate recent count:5 language:de` — choose an explicit target language.

When no target is supplied to `/translate text`, automatic source detection is restricted
to the configured standard language pair. Supplying a target allows the service to detect
other source languages too.

Recent-message translation requires View Channel, Read Message History, and Send Messages.
Manage Messages is also needed if the bot is to delete original messages after successfully
posting their replacements. Bot-authored messages are skipped.

The bot keeps local translation metadata in `voice-bot/translation-history.json` so later
recent-message translations can avoid duplicating work. Keep this file with the bot's data
if you want that history to persist when moving machines.

## 9. Performance settings and logs

The following settings are optional; the values shown are the defaults.

| Variable | Default | What it controls |
|---|---:|---|
| `MAX_CONCURRENT_UTTERANCES` | `3` | Maximum audio-chunk jobs processing concurrently in the Discord bot. |
| `SILENCE_MS` | `500` | Silence duration that ends a speaker's capture stream. |
| `MIN_UTTERANCE_MS` | `500` | Ignore captured chunks shorter than this. |
| `MAX_UTTERANCE_MS` | `4000` | Hard maximum chunk length during continuous speech. Shorter chunks produce earlier partial subtitles. |
| `SEGMENT_SEARCH_MS` | `1200` | How far back from the hard limit to search for a quieter split point. |
| `SEGMENT_MIN_MS` | `2500` | Minimum segment duration before quiet-boundary splitting is considered. |
| `SEGMENT_QUIET_RMS` | `700` | RMS threshold used to identify a quiet split window. |
| `WHISPER_BEAM_SIZE` | `1` | Whisper search width; 1 is faster, while larger values can improve recognition accuracy. |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `2` | Simultaneous Whisper inference jobs in the Python service. |
| `MAX_CONCURRENT_TRANSLATIONS` | `2` | Simultaneous translation requests in the Python service. |

The bot's queue log reports **waiting**, **active**, and **total** jobs. The Python service
logs queue wait, speech-recognition time, translation time, and total processing time.
Use these timings to identify the bottleneck before changing concurrency. Increasing
concurrency can improve throughput with multiple speakers, but may increase GPU/VRAM
contention and does not necessarily make a single utterance finish faster.

## 10. Optional desktop overlay

The Electron overlay is independent of the Python service and Discord bot. To install and
start it, open a **third** PowerShell window:

```powershell
cd overlay
npm install
npm start
```

The overlay has two ways to receive subtitles:

- **Discord** — reads the overlay's configured Discord channels using Discord desktop RPC.
  This mode requires the Discord desktop app and valid `DISCORD_CLIENT_ID` and
  `DISCORD_CLIENT_SECRET` environment variables to be present in the Electron process.
  Unlike the bot and Python service, the overlay does **not** load the project's root
  `.env` automatically. Set those variables in the PowerShell session before running
  `npm start`. The Discord application must also have the RPC/redirect configuration
  expected by the overlay.
- **Relay** — receives transcript updates directly from the bot. Friends do not need
  Discord RPC credentials. Configure the relay URL and personal token in overlay Settings.
- **Both** — listens to Discord and the relay, filtering duplicate message IDs.

The overlay defaults to Discord mode. For a simpler setup that does not require Discord RPC
credentials on each overlay PC, use Relay mode and configure the host relay below.

### Build a Windows installer (.exe)

The overlay can be packaged as a normal Windows desktop application. This installer
contains the Electron overlay only; the Discord voice bot, Python transcription service,
Ollama, and any host relay must still be running separately where your setup needs them.

From PowerShell:

```powershell
cd overlay
npm install
npm run dist
```

The first build downloads the Windows packaging tool, so an internet connection is needed.
The installer will be created at:

```text
overlay/release/Wookie-Translator-Setup-1.1.0.exe
```

The installer displays the Wookie Translator End User Licence Agreement (EULA). Users
must accept it before installation can continue. The agreement is also available at
`EULA.md`; the proprietary personal-use licence is in `LICENSE`, and the data-handling
notice is in `PRIVACY.md`.

The software is free for personal, non-commercial use. Redistribution, commercial use,
and distribution of modified versions require prior written permission, subject to rights
that cannot legally be restricted. Third-party components retain their own licences.

Run the installer to install Wookie Translator. It creates Start Menu and desktop shortcuts
and keeps the user's settings when the app is uninstalled. To create an unpacked test build
instead of an installer, run `npm run pack`; the app folder will be in
`overlay/release/win-unpacked/`.

This installer is not code-signed. Windows may show its normal publisher/SmartScreen
warning. A software licence does not replace a code-signing certificate or remove Windows
publisher warnings.

### Host: enable the authenticated relay

1. Generate a unique token for each person who should connect. Run this in PowerShell:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Add the credentials to the root `.env`. Use a unique label for each token:
   ```env
   OVERLAY_RELAY_PORT=8765
   OVERLAY_RELAY_TOKENS=owner:PASTE_64_CHARACTER_TOKEN,friend1:PASTE_THEIR_64_CHARACTER_TOKEN
   ```
3. Restart the Discord bot. It should log that the relay is listening on
   `http://127.0.0.1:8765`. If no valid token entries are configured, the relay remains
   disabled and normal Discord channel posting still works.
4. For connections from outside the host PC, run a Cloudflare Quick Tunnel in another
   terminal:
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8765
   ```
5. Convert the generated HTTPS hostname to a WebSocket URL by using `wss://` and adding
   `/overlay`. For example:
   `wss://YOUR-HOST.trycloudflare.com/overlay`.
   Keep the tunnel running. A Quick Tunnel hostname is temporary and may change when
   restarted.

The relay binds to loopback (`127.0.0.1`); use the tunnel for remote connections rather
than exposing the relay port directly to the internet. The relay sends transcript text and
display metadata, not voice audio.

### Friend: connect an overlay

1. Start the overlay and open its Settings.
2. Choose **Relay** (or **Both**).
3. Paste the host's `wss://.../overlay` URL and the personal token the host generated for
   you.
4. Save and select the languages to display.

The overlay stores the token using the operating system's secure storage. Each person
should have their own token. To revoke access, remove that person's `label:token` entry
from the host's `.env` and restart the Discord bot.

## 11. Audio recording, message cleanup, and privacy

- By default, voice audio is processed in memory and is not written to disk.
- Set `RECORD_WAV=true` only when you deliberately want local WAV recordings for debugging.
  Recordings are written under `voice-bot/recordings/`. Turn it back off after testing.
- Bot subtitle messages are automatically deleted after `MESSAGE_DELETE_SECONDS`
  (default: 300 seconds / 5 minutes). Set it to `0` to disable automatic deletion.
- **Important:** `/leave` disconnects the bot and then scans the configured language/live
  output channels, deleting messages authored by this bot. It does not delete user-authored
  messages. The bot needs View Channel, Read Message History, and Manage Messages for
  cleanup to work fully.
- Recent-message translation metadata is stored locally in
  `voice-bot/translation-history.json`. Treat it as private server data.
- Tell everyone in the voice channel that the bot is listening and that their speech may be
  transcribed and translated. Follow your server's consent and privacy rules.

## Troubleshooting

**The bot says `Missing DISCORD_TOKEN in .env`**
- Make sure `.env` is in the project root, beside this README.
- Check that the variable is named `DISCORD_TOKEN` and that the token is valid.

**The bot joins Discord but no transcripts appear**
- Confirm the Python service is running at `SERVICE_URL`.
- Open `http://127.0.0.1:8000/health` and check the service is healthy.
- Confirm the bot can view and send messages in the configured output channels.
- Check both the Python and bot terminal windows for errors.

**Whisper fails to load CUDA libraries**
- Confirm the NVIDIA driver is installed and up to date.
- Re-activate the Python virtual environment and reinstall the pinned requirements:
  `pip install -r requirements.txt`.
- As a diagnostic fallback, set `WHISPER_DEVICE=cpu` and
  `WHISPER_COMPUTE=int8`, then restart the service.

**Translation does not happen**
- `TRANSLATOR=none` performs transcription only.
- For Ollama, make sure Ollama is running, the model exists, and `LLM_BASE_URL` and
  `LLM_MODEL` match your local setup.
- For Google, check `GOOGLE_API_KEY` and API access.

**Slash commands are missing**
- Run `npm run register` from `voice-bot/` after checking
  `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` in the root `.env`.

**Overlay relay says it is disabled**
- Check that `OVERLAY_RELAY_TOKENS` contains at least one unique `label:token` entry.
- Each token must be at least 32 characters. Restart the bot after editing `.env`.

---

## Quick start: which terminals stay open?

1. **Terminal 1 — Python:** activate `service/.venv` and run `python main.py`.
2. **Terminal 2 — Discord bot:** run `npm start` from `voice-bot/`.
3. **Terminal 3 — Overlay (optional):** run `npm start` from `overlay/`.
4. **Terminal 4 — Cloudflare Tunnel (optional):** run the tunnel command only if remote
   overlay clients need to connect.

Keep the Python service and Discord bot running while translating.


## Docker deployment

Docker Compose runs the Whisper API, Ollama, and Discord bot in containers. The optional
Electron overlay remains a native Windows application. The native installation instructions
above remain available as an alternative.

### Prerequisites

- Docker Desktop for Windows using the WSL2 backend.
- A current NVIDIA Windows driver and working NVIDIA GPU support in Docker Desktop/WSL2
  if you want GPU inference. CPU operation may be possible but is not the recommended
  configuration for this deployment.
- A Discord application and bot account configured as described above.
- The project-root `.env` file with your Discord credentials.

### Configure the environment

From the repository root, copy the example environment file and edit the copy:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set at least these values:

```env
DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN
DISCORD_CLIENT_ID=YOUR_DISCORD_APPLICATION_ID
DISCORD_GUILD_ID=YOUR_DISCORD_SERVER_ID
TRANSLATOR=openai
LLM_MODEL=translategemma:4b
```

Keep the actual `.env` private and uncommitted. Do not paste it into support requests.
The Compose configuration defaults to `translategemma:4b` when `LLM_MODEL` is empty or
unset. You can choose another Ollama model by changing `LLM_MODEL`; the model-init
service will pull that same configured model. For the bundled Ollama service, Compose
sets the internal translator URL to `http://ollama:11434` automatically.

The example file sets `TRANSLATOR=none` for a safe transcription-only native first test.
For Docker translation with the bundled Ollama service, change it to
`TRANSLATOR=openai` as shown above.

### Build and start

Run these commands from the repository root:

```powershell
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps -a
```

The first build can take a while. On first startup, Compose waits for Ollama to become
healthy, then runs the one-shot `ollama-model-init` service. That service executes
`ollama pull` for the model named by `LLM_MODEL` (default: `translategemma:4b`).
The Discord bot waits until that pull completes successfully before it starts. You do
not need to run `docker compose exec ollama ollama pull ...` manually.

To confirm the model initialization succeeded:

```powershell
docker compose logs ollama-model-init
docker compose exec ollama ollama list
```

The init container showing `Exited` in `docker compose ps -a` is expected: it is a
one-shot task and should exit successfully after printing `success`. If it fails, inspect
its logs before troubleshooting the bot.

### Services and networking

- `whisper`: FastAPI and Faster-Whisper, with NVIDIA GPU reservation and a persistent
  model cache.
- `ollama`: Ollama with NVIDIA GPU reservation and persistent model storage.
- `ollama-model-init`: one-shot model download that completes before the bot starts.
- `bot`: Discord bot and authenticated overlay relay.
- `cloudflared`: optional tunnel connector, enabled with the `tunnel` profile.
- Electron remains a native Windows application.

The Python API and Ollama have no published host ports. They are reachable only on the
private backend network. The bot joins the backend and edge networks; the tunnel connector
joins only the edge network. No ports are published to the host. Compose overrides the
internal URLs so the bot calls `http://whisper:8000` and the Python translator calls
`http://ollama:11434`.

### Data persistence

Whisper and Ollama model data are stored in named Docker volumes
(`whisper_models` and `ollama_models`). Bot settings, translation history, and optional
recordings are stored under the ignored local `data/voice-bot` directory.

Restarting or recreating containers does not remove the named volumes. The following
command stops and removes containers and networks while preserving model data:

```powershell
docker compose down
```

Do not use `docker compose down -v` unless you deliberately want to delete the downloaded
Whisper and Ollama models as well.

### Check logs and service health

First, list the services defined in the Compose file and check their current status:

```powershell
docker compose config --services
docker compose ps -a
```

Use the service name at the end of `docker compose logs` to choose which service
to inspect. The service names in this deployment are:

| Service | What it runs |
|---|---|
| `bot` | Discord bot and authenticated overlay relay |
| `whisper` | Speech recognition and translation API |
| `ollama` | Local Ollama model server |
| `ollama-model-init` | One-shot task that downloads the configured model |
| `cloudflared` | Optional Cloudflare Tunnel connector (when the `tunnel` profile is enabled) |

For example, follow only the bot's logs live:

```powershell
docker compose logs -f bot
```

Replace `bot` with any service name from the table to watch that service instead.
You can also watch more than one selected service by listing their names:

```powershell
docker compose logs -f bot whisper
```

Omit the service names to watch all services:

```powershell
docker compose logs -f
```

Press `Ctrl+C` to stop following the logs; this does **not** stop the containers.

Useful options can be combined with a selected service:

```powershell
# Show only the latest 100 lines from the bot
docker compose logs --tail 100 bot

# Show bot logs from the last 10 minutes
docker compose logs --since 10m bot

# Follow the bot live and include timestamps
docker compose logs -f -t bot

# Inspect the one-shot model download task
docker compose logs ollama-model-init
```

The Whisper logs include queue wait, transcription, translation, and total processing
times. `ollama ps` shows whether the model is loaded and which processor is being used:

```powershell
docker compose exec ollama ollama ps
```

Use `docker compose logs --help` to see all available log options. See the
[Docker Compose logs reference](https://docs.docker.com/reference/cli/docker/compose/logs/)
for details.

### Optional Cloudflare Tunnel connector

After creating a named tunnel in Cloudflare, add its secret token to the untracked root
`.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=YOUR_SECRET_TUNNEL_TOKEN
```

Then start the connector:

```powershell
docker compose --profile tunnel up -d
```

In Cloudflare, configure the public hostname to route to `http://bot:8765`. The connector
and bot share the private edge network. Expose the relay only; do not route public traffic
to the Python API (8000) or Ollama (11434).

### Troubleshooting

**The bot does not start and the model-init service failed**

- Check `docker compose logs ollama-model-init` for the pull error.
- Confirm Ollama is healthy with `docker compose ps -a`.
- Confirm `LLM_MODEL` is a valid Ollama model name and that the host has enough disk space.

**The bot joins Discord but no transcripts appear**

- Check `docker compose ps -a` and confirm both `whisper` and `ollama` are healthy.
- Inspect `docker compose logs --tail 100 bot whisper`.
- Confirm the bot can view and send messages in the configured output channels.

**Translation does not happen**

- Confirm `TRANSLATOR=openai` in the root `.env`.
- Confirm the configured model appears in `docker compose exec ollama ollama list`.
- Check `docker compose logs whisper ollama` for API errors.

**GPU inference is unavailable**

- Confirm the NVIDIA driver is current and Docker Desktop is using WSL2.
- Check `docker compose logs whisper ollama` for CUDA or GPU initialization errors.
- Use `docker compose exec ollama ollama ps` while the model is loaded to inspect its
  processor placement.

### Security and limitations

- Keep secrets in the untracked root `.env`; never put them in images or Git.
- The relay is the only service reachable from the tunnel network.
- Python and Ollama ports are not published to the host.
- Containers run as a non-root user where supported by the application image.
- GPU reservation syntax depends on the installed Docker Desktop, NVIDIA driver, and
  Compose versions.
- Pin image versions and review dependencies periodically before using this as a
  long-running public service.
