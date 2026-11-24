# Audio test harness

This folder contains the reproducible audio-test runner. The first end-to-end milestone uses one dedicated Discord speaker bot to play a manifest-defined sequence of prerecorded PCM WAV fixtures while the translator listens.

## First sequential playlist

The manifest is tracked at `audio-tests/manifest.json`. Fixture audio stays local in the ignored `audio-tests/fixtures/` directory and is mounted read-only into the test container.

Run inside the dedicated translator container:

```sh
npm run audio-test -- run --guild-id GUILD_ID --channel-id VOICE_CHANNEL_ID --manifest /audio-tests/manifest.json
```

The runner validates and loads every listed fixture before connecting, starts the translator, connects the speaker bot once, plays the clips in manifest order with the configured gap, waits for translator processing to drain, and stops the translator session. It emits a unique run ID and timestamped playback events.

The initial manifest uses the three files in `speaker-1`. They are all played by the same Discord bot identity. The `speaker` folders are just local organization at this stage; separate Discord speaker identities and overlaps will be added in a later milestone.

Manifest paths are relative to `/audio-tests` and must resolve inside `/audio-tests/fixtures`. `expectedLanguage` is test metadata for comparing the result later; it is not sent to or used to influence the translator. `gapMs` is the quiet interval between clips. Fixture WAV files must be uncompressed PCM, 48 kHz, stereo, 16-bit, and no larger than 100 MB each.

Keep fixture recordings you own or have permission to use in the local ignored fixture directory.

## Environment and permissions

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
- Host-side resource sampling correlated with each run.
- Offline PCM replay as a separate mode. It bypasses Discord transport and Opus decoding, so it complements rather than replaces end-to-end Discord tests.
