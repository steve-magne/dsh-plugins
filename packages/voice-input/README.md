# @dsh-plugins/voice-input

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
**on-device voice dictation** for the web surface — the GitHub-Copilot-app
"voice conversations" workflow. A microphone toggle lands in the composer tool
row; speak, stop, and the transcript is inserted straight into your message.

```
 composer tool row (inside the card)
┌──────────────────────────────────────────────────┐
│ [access] [plan] [🟢 Worktree] [PR] [🎙] [model] [↑] │
└──────────────────────────────────────────────────┘
        click = dictate · right-click = engine
```

## Two engines, one promise: nothing leaves the machine by default

| Engine | How | Privacy story |
| --- | --- | --- |
| `webapi` (default when available) | browser `SpeechRecognition` / `webkitSpeechRecognition` | engine-dependent — Safari's is on-device; Chrome may use a cloud recognizer |
| `local` | `MediaRecorder` → plugin host half → ONE configured local ASR server (whisper.cpp's `/v1/audio/transcriptions`, or any OpenAI-compatible one) | strict loopback: the forwarder validates the endpoint at activation and refuses anything that is not `localhost`/`127.x`/`::1` |

Right-click the mic to cycle `auto → webapi → local` (persisted in
`localStorage`; a tiny `w`/`L` badge shows a pinned choice).

## Behavior

1. Click the mic: recording starts (pulsing red). Click again: the transcript
   is appended to the composer textarea through the native value setter +
   `input` event, so React state updates cleanly; if no composer exists (e.g.
   focus elsewhere), the text goes to the clipboard instead.
2. Recordings are capped at 120 s; audio bodies at 10 MB.
3. The browser half discovers whether local transcription is usable from
   `GET /voice-input/api/config` and says so instead of failing mid-dictation.
4. Errors (permission denied, no microphone, ASR down) surface as an inline
   hint on the button, never as a silent no-op.

## Install

```bash
# 1. Link the package into the web-surface profile's plugin tree
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-plugins
ln -s /Users/stevemagne/workspace/dsh-plugins/packages/voice-input \
      ~/.dsh/profiles/web/node_modules/@dsh-plugins/voice-input

# 2. Mount it as a Loader entry (~/.dsh/profiles/web/cordis.patch.yml)
#    - insert:
#        - id: voice-input
#          name: '@dsh-plugins/voice-input'
#          config:
#            # optional: enables the 'local' engine (MUST be loopback)
#            asrUrl: http://127.0.0.1:8080/v1/audio/transcriptions

# 3. Restart the harness — the web surface has no config hot-reload; new
#    entries mount at boot.
```

With [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp) running locally:

```bash
whisper-server --host 127.0.0.1 --port 8080   # exposes /v1/audio/transcriptions
```

## API

Prefix route `/voice-input/api` (Host allowlist; loopback-only upstream):

| Method & path | Body | Effect |
| --- | --- | --- |
| `GET /config` | — | `{asrEnabled, asrOrigin, reason?, maxAudioBytes}` |
| `POST /transcribe` | raw `multipart/form-data` or `audio/*` | forwarded verbatim to the configured endpoint; answers `{text}` |

> The forwarder deliberately proxies exactly ONE preconfigured loopback URL —
> it is not a general-purpose relay. Upstream failures answer 502 with a
> truncated body; oversized recordings answer 413 before leaving the host.

## Tests

```bash
node packages/voice-input/test/run.mjs          # validator + forwarder against a stubbed fetch
node packages/voice-input/test/client-check.mjs # bundle contract in a stubbed DOM
```
