# Shruti

Real-time meeting recorder & transcriber. A Linux **client** captures everything
that plays in apps (Zoom/browser/…) **and** the microphone as two separate
channels, streams the audio live to a Mac **host** that runs Parakeet on the
Apple Neural Engine, and shows transcription **as it is spoken** — then produces
a summary. This is streaming, not record-then-transcribe.

```
 yoga (Linux)                                          mridanga (macOS, M4/ANE)
┌──────────────────────────────┐                      ┌───────────────────────────────┐
│ shruti (Wails v2, 1 binary)  │   WebSocket :8082    │ streamd (Go)                  │
│  capture: system + mic       │ ══ PCM (system) ═══▶ │  ├─ spawns fluidstreamd ──┐   │
│   → 2× 16k mono s16le         │ ══ PCM (mic) ══════▶ │  └─ spawns fluidstreamd ──┤   │
│  Vue UI: 2 live tracks я/они  │ ◀═ Update JSON ═════ │       (Swift, StreamingEou │   │
│  session → store → summary    │                      │        AsrManager, ANE) ◀──┘   │
└──────────────────────────────┘   via tailnet fwd    └───────────────────────────────┘
                                    127.0.0.1:18005 → mridanga:8082
```

## Repository layout

```
proto/v1/           Shared wire contract (Go). Single source of truth. See messages.go.
host/
  fluidstreamd/     Swift: streaming ASR on the ANE. stdin PCM → stdout NDJSON.   🔒macOS
  streamd/          Go: WebSocket server; one fluidstreamd child per channel.
  Makefile          swift build -c release + go build → host/bin/
client/
  cmd/shruti/       Wails v2 entrypoint.
  internal/
    capture/        PipeWire: system (sink monitor) + mic → 2× PCM streams.
    provider/       Transcriber interface + parakeet (default) / deepgram impls.
    summary/        Summarizer interface + Claude impl.
    session/        Orchestrates capture → provider → UI events → store.
    store/          Persist transcript + summary + (optional) audio.
  frontend/         Vue 3 + Vite: live subtitles, 2 tracks, summary.
nix/                Pointer; the nix-darwin host module lives in the dotfiles repo.
```

Multi-module Go via `go.work` (proto + host/streamd; `go work use ./client` once
the Wails module exists).

## Protocol (frozen)

Audio everywhere: **signed 16-bit little-endian PCM, mono, 16 kHz** (`proto/v1`).

### 1. client ↔ streamd — WebSocket

- One connection **per channel**. Open `ws://<host>:8082/v1/stream?channel=system&lang=ru`
  (`channel` ∈ `system|mic`, required; `lang` optional).
- **client → server**: *binary* frames = raw PCM, streamed live as captured.
  *text* frames = `Control` JSON: `{"type":"finalize"}` (flush utterance) /
  `{"type":"close"}` (end session).
- **server → client**: *text* frames = `Update` JSON, emitted continuously:
  ```json
  {"type":"partial","channel":"system","text":"...","ts_ms":1234}
  {"type":"final","channel":"system","text":"...","ts_ms":5678}
  ```
  `partial` = running hypothesis (may be revised); `final` = committed segment.

### 2. streamd ↔ fluidstreamd — stdio (one process per channel)

- streamd spawns `fluidstreamd --lang ru` per WebSocket connection.
- **stdin**: raw PCM bytes only — the live stream, fed as it arrives (NOT a file).
- **stdout**: NDJSON, one `Update` per line (no `channel` — streamd stamps it),
  flushed immediately: `partial` lines stream continuously, `final` at each EOU.
- **EOF on stdin** → `finish()` flushes the tail → last `final` → exit 0.
- Model loads once at process start (~1–2 s); amortized over the meeting.

Engine: FluidAudio `StreamingEouAsrManager` (Parakeet EOU, cache-aware, 160 ms
chunks). Parakeet-**TDT** (the batch model) is offline sliding-window and does
**not** conform to the streaming protocol — do not use it here.

## Extending

- **New transcription provider** (e.g. OpenAI, whisper.cpp): implement
  `provider.Transcriber` and register it in the factory map. `parakeet` (host) is
  the default; `deepgram` is a drop-in cloud alternative. Selectable per session.
- **New summarizer**: implement `summary.Summarizer` (default: Claude/Anthropic).

## Build

- **host** (on mridanga): `make -C host build` → `host/bin/{fluidstreamd,streamd}`.
- **client** (on yoga): `make -C client build` → single `shruti` binary (Vue embedded).

Deployment to mridanga is declarative via the dotfiles nix-darwin module
`features.darwin.shruti-host` (bootstrap agent = git pull + make; service agent
runs `streamd :8082`). Update: kickstart the bootstrap then the streamd agent.
