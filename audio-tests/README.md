# Audio test harness

This folder contains reproducible end-to-end tests using three dedicated Discord speaker bots. Audio fixtures stay local in the ignored `audio-tests/fixtures/` directory and are mounted read-only into the dedicated test container.

## Test profiles

Run these commands inside the dedicated translator container:

```sh
npm run audio-test -- short
npm run audio-test -- long
```

Both profiles accept `--language-mode auto` (default) or `--language-mode configured`.

- **Short:** approximately 4 minutes of scheduled playback. Use it first to verify all three bots connect, audio is recognized, overlaps work, and cleanup succeeds.
- **Long:** approximately 25 minutes of scheduled playback, with repeated clips, staggered starts, and overlapping speakers. Use it for sustained load and game-performance comparisons.

Each profile uses the same deterministic 75-second cycle: speaker 1 starts at the cycle boundary, speaker 2 starts 20 seconds later, and speaker 3 starts 40 seconds later. Each speaker's clips are rotated in manifest order. This creates repeatable cross-speaker overlap without scheduling a second clip for the same bot before its previous 30–44 second clip should have finished.

Run each language mode with the same profile and fixture files. Automatic mode supplies empty language preferences for every test speaker. Configured mode uses the manifest preferences: speaker 1 English, speaker 2 English, and speaker 3 English and Spanish.

The pre-language-change baseline must be run from the original pre-change code revision in a separate test checkout/Compose project. Do not replace or downgrade the active test branch to run it, and never use the production Compose project for these tests.

## Speakers and local credentials

The manifest is `audio-tests/manifest.json`. It maps each speaker label to its Discord user ID and lists the recordings assigned to that speaker.

The root `.env` file on your machine should contain paired comma-separated lists in the same order:

```dotenv
AUDIO_TEST_SPEAKER_IDS=ID_1,ID_2,ID_3
AUDIO_TEST_SPEAKER_TOKENS=TOKEN_1,TOKEN_2,TOKEN_3
AUDIO_TEST_GUILD_ID=YOUR_TEST_SERVER_ID
AUDIO_TEST_CHANNEL_ID=YOUR_TEST_VOICE_CHANNEL_ID
```

The runner pairs each ID with the token at the same list position and verifies that each token authenticates as the expected Discord user. The IDs must be unique, and the lists must have the same number of entries. Never put real credentials in Git or logs. Do not share tokens or your `.env` file.

The translator test container also needs:

- `AUDIO_TEST_CONTROL_ENABLED=true`
- `AUDIO_TEST_CONTROL_TOKEN`: unique random value of at least 32 characters
- `AUDIO_TEST_SPEAKER_IDS`: the same comma-separated speaker IDs

The speaker bots need permission to view and connect to the test voice channel. The translator's speaker-ID allowlist must include all three speaker bot user IDs.

## Fixtures

Fixture paths are relative to `/audio-tests` and must resolve inside `/audio-tests/fixtures`. WAV files must be uncompressed PCM, 48 kHz, stereo, 16-bit, and no larger than 100 MB each. Keep recordings you own or have permission to use in the local ignored fixture directory.

The current manifest expects:

- `speaker-1`: three English recordings
- `speaker-2`: two English recordings
- `speaker-3`: one Spanish and one English recording

The runner validates and loads all fixture files before connecting to Discord.

## Monitoring and results

Start the resource monitor on the Windows Docker host in a second PowerShell terminal before starting a profile:

```powershell
.\\audio-tests\\runner\\monitor.ps1 -RunId YOUR_RUN_ID
```

The runner prints a unique run ID when it starts. Use that ID with the monitor. The monitor samples Docker CPU and memory plus NVIDIA GPU utilization, VRAM, temperature, and power when available. CSV output is saved under `audio-tests/results/`.

Translator JSONL events are written to Docker stdout and `/data/audio-test-logs/<run-id>.jsonl`. They include queue timing, service processing duration, detected language, translation count, and errors; transcript text and audio content are not included.

The current monitor does not automatically measure game FPS or frame times. Record those separately using the game's built-in performance overlay or an existing trusted monitoring tool. Compare the same game scene/settings during each test round.

## Manual session controls

The separate `start` and `stop` actions remain available for diagnostics:

```sh
npm run audio-test -- start --guild-id GUILD_ID --channel-id VOICE_CHANNEL_ID
npm run audio-test -- stop --guild-id GUILD_ID
```

The private control API binds to `127.0.0.1` only and is authenticated with `AUDIO_TEST_CONTROL_TOKEN`. It is intended to be called only from inside the same translator container, not exposed through Cloudflare or a host-published port.

