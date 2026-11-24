# Audio test harness

This folder contains the reproducible audio-test runner. The first end-to-end milestone supports one dedicated Discord speaker bot playing a prerecorded PCM WAV fixture while the translator listens.

## Current single-speaker test

The runner starts the translator session, logs in the speaker bot, joins it to the same voice channel, plays the fixture, waits for translator processing to drain, and stops the translator session in one command.

Run inside the dedicated translator container:

```sh
npm run audio-test -- run --guild-id GUILD_ID --channel-id VOICE_CHANNEL_ID --fixture /audio-tests/fixtures/speaker-1/test.wav
```

Optional `--start-delay-ms N` delays playback after the speaker bot has joined. The WAV must be uncompressed PCM, 48 kHz, stereo, 16-bit. Keep fixture recordings you own or have permission to use in the local ignored `audio-tests/fixtures/` directory.

The test container needs these environment variables:

- `AUDIO_TEST_CONTROL_ENABLED=true`
- `AUDIO_TEST_CONTROL_TOKEN`: unique random value of at least 32 characters
- `AUDIO_TEST_SPEAKER_TOKEN`: token for the dedicated speaker bot account
- `AUDIO_TEST_SPEAKER_IDS`: comma-separated Discord user IDs for all dedicated speaker bot accounts

Never put real credentials in Git or logs. Do not share tokens or your `.env` file.

Mount local fixtures read-only into the bot container, for example in the test Compose service:

```yaml
volumes:
  - ./audio-tests/fixtures:/audio-tests/fixtures:ro
```

The speaker bot needs permission to view and connect to the test voice channel. The translator must also have Connect permission. The translator's speaker-ID allowlist must include the speaker bot's user ID; other bot accounts remain ignored by capture.

## Translator session control

The separate `start` and `stop` actions remain available for diagnostics:

```sh
npm run audio-test -- start --guild-id GUILD_ID --channel-id VOICE_CHANNEL_ID
npm run audio-test -- stop --guild-id GUILD_ID
```

The private control API binds to `127.0.0.1` only and is authenticated with `AUDIO_TEST_CONTROL_TOKEN`. It is intended to be called only from inside the same translator container, not exposed through Cloudflare or a host-published port.

The existing `/join` and `/leave` commands remain available for normal manual use.

## Structured translator logs

During a test run, the translator emits JSON events to Docker stdout and appends the same events to:

```
/data/audio-test-logs/<run-id>.jsonl
```

Events include session start/stop, captured segment duration and byte count, queue state/wait, service processing duration, detected language, translation count, empty results, errors, and total utterance processing time. Transcript text and audio content are not included.

## Local resource monitor (Windows Docker host)

The PowerShell monitor samples the dedicated Docker Compose project and, when available, NVIDIA GPU utilization, VRAM, temperature and power. Run it on the Docker host in a second terminal:

```powershell
.\\audio-tests\\runner\\monitor.ps1 -RunId YOUR_RUN_ID
```

It writes one CSV row per running project container per sample under `audio-tests/results/`. Stop it with Ctrl+C.

## Next milestones

- Multiple speaker bots with per-speaker fixtures and scheduled offsets/overlaps.
- A manifest-driven test plan and repeatable run summary.
- Host-side resource sampling correlated with each run.
- Offline PCM replay as a separate mode. It bypasses Discord transport and Opus decoding, so it complements rather than replaces end-to-end Discord tests.
