# Audio test harness

This folder contains the reproducible audio-test runner. Development is incremental: the first runner milestone controls the translator session; sender-bot playback and resource sampling are added next.

## Intended test flow

1. Start the runner from a terminal on the Docker host (using `docker exec`).
2. The runner starts a uniquely identified test session in the translator.
3. Dedicated speaker bots join the selected Discord voice channel and play per-speaker fixtures on a shared timeline.
4. The runner waits for processing to drain, stops the session, and saves run metadata and measurements.
5. Translator-side JSONL events and local resource samples are correlated by run ID.

The existing `/join` and `/leave` commands remain available for normal manual use. Automated tests use the private control API and do not require a Discord slash-command interaction.

## Current implementation

The first CLI milestone can start and stop a translator test session:

```sh
npm run audio-test -- start --guild-id GUILD_ID --channel-id VOICE_CHANNEL_ID
npm run audio-test -- stop --guild-id GUILD_ID
```

Run these commands inside the dedicated test bot container. The start command prints a generated run ID. The stop command uses the existing translator cleanup behavior, including clearing the bot's configured output messages, as agreed for test runs.

The control API is deliberately bound to `127.0.0.1` only. It is authenticated with `AUDIO_TEST_CONTROL_TOKEN`, and is intended to be called only by the runner process in the same container. It is not exposed through Cloudflare or a host-published port.

Set these variables only on the dedicated test translator:

- `AUDIO_TEST_CONTROL_ENABLED=true`
- `AUDIO_TEST_CONTROL_TOKEN` to a unique random value of at least 32 characters
- `AUDIO_TEST_SPEAKER_IDS` to comma-separated user IDs for the dedicated speaker bots

Do not put real credentials in Git or logs.

## Structured translator logs

When a test run is active, the translator emits JSON events to Docker stdout and appends the same events to:

```
/data/audio-test-logs/<run-id>.jsonl
```

Events include session start/stop, captured segment duration and byte count, queue state/wait, service processing duration, detected language, translation count, empty results, errors, and total utterance processing time. Transcript text and audio content are not included.

The JSONL file is stored under the bot's existing persistent `DATA_DIR` volume. Docker logs remain available as a secondary record.

## Planned fixture layout

```
audio-tests/
  fixtures/
    speaker-1/
    speaker-2/
  runner/
  results/
```

Use recordings you made or have permission to use. Keep private voice recordings and generated results out of Git.

## Local resource monitor (Windows Docker host)

The PowerShell monitor samples the dedicated Docker Compose project and, when available, NVIDIA GPU utilization, VRAM, temperature and power. Run it on the Docker host in a second terminal after starting a test:

```powershell
.\\audio-tests\\runner\\monitor.ps1 -RunId YOUR_RUN_ID
```

It writes one CSV row per running project container per sample under `audio-tests/results/`. Stop it with Ctrl+C. This monitor is intentionally host-side because a process inside the bot container cannot accurately inspect host GPU and all Docker container metrics without extra privileges.

## Next milestones

- Dedicated sender-bot login and voice playback, one bot identity per simulated speaker.
- A fixture manifest with file paths, start offsets, durations, and overlap.
- A runner that starts playback, waits for all processing jobs to finish, then stops the translator.
- Host-side resource sampling for CPU, RAM, GPU/VRAM and Docker containers. Resource samples should be timestamped and saved alongside the JSONL logs.
- A results summary that correlates playback schedule, translator processing events, and resource samples.

Offline PCM replay can be added as a separate test mode later; it bypasses Discord transport and Opus decoding, so it complements rather than replaces the end-to-end Discord test.
