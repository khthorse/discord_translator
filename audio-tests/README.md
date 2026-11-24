# Audio test harness

This folder will contain the reproducible prerecorded-audio test runner.

## Planned test levels

1. **Offline pipeline replay** — feed paced PCM from per-speaker fixtures into the same segmentation and transcription path. This is repeatable and isolates recognition/queue behavior, but bypasses Discord transport and Opus decoding.
2. **Discord voice test** — dedicated sender bot accounts play the fixtures into a selected voice channel. The dedicated test translator receives the audio through Discord's actual voice receiver and Opus decoder.

The Discord test is the end-to-end check. It needs one distinct Discord bot identity per simulated speaker because Discord associates received audio with user IDs. Use a separate test translator bot identity too; a Discord bot token cannot safely run two simultaneous clients.

## Planned fixture layout

```text
audio-tests/
  fixtures/
    speaker-1/
    speaker-2/
  runner/
  results/
```

Use recordings you made or have permission to use. Keep test audio out of Git if it contains private voices; a local fixture directory can be ignored by Git in a later setup step.

## Translator control endpoint

The first implementation adds a private control endpoint to the voice bot. It is disabled by default and is intended only for the dedicated test instance.

- `POST /join` with JSON `{"guildId":"…","channelId":"…"}`
- `POST /leave` with JSON `{"guildId":"…"}`
- Supply `Authorization: Bearer <token>`
- The token must be at least 32 characters.
- `/leave` disconnects the test voice session only. It does **not** call the normal `/leave` command or delete any Discord messages.
- `AUDIO_TEST_SPEAKER_IDS` is a comma-separated allowlist of dedicated speaker bot user IDs. Other bot accounts remain ignored.

Configure with the `AUDIO_TEST_CONTROL_*` and `AUDIO_TEST_SPEAKER_IDS` variables documented in the root `.env.example`. Do not commit real credentials.

### Network safety

Keep the endpoint on loopback when the runner is on the same machine. If the runner is on another computer, expose it only over a trusted private VPN or an equivalently protected network, and restrict the port with the host firewall. The bearer token is a credential; do not expose this plain-HTTP endpoint directly to the public internet. A TLS-protected control route can be added if the deployment needs one.

## Current status

The translator-side control path is in place. The CLI runner, sender-bot orchestration, fixture playback/timing format, result collection, and Docker packaging are not implemented yet. They will be added in small steps and reviewed before running against Discord.
