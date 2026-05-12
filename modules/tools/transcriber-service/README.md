# transcriber-service

LAN-local HTTP service for fast audio transcription on Apple Silicon. Built around NVIDIA **Parakeet-TDT-0.6b-v3** running on the Apple Neural Engine via [FluidAudio](https://github.com/FluidInference/FluidAudio). Measured throughput on Apple M4 base: **~308× realtime** with two concurrent workers — i.e. one hour of audio is transcribed in roughly 12 seconds.

```
client (any machine) ──HTTP──► transcriber (Go) ──stdin──► fluidbatchd (Swift, ANE)
                              │  ~/.transcriber/
                              │  ├─ jobs.db
                              │  ├─ audio/<id>.mp3
                              │  └─ transcripts/<id>.json
```

The Go service handles uploads, ownership, queueing and persistence. The Swift side (`fluidbatchd/`) is a long-running subprocess that loads CoreML models once and crunches files as paths arrive on its stdin. State survives restart (SQLite + filesystem).

## Requirements

- Apple Silicon Mac (tested on M4; works on M1/M2/M3 too).
- macOS 14+ (Sonoma).
- **Swift 6** (`swift --version` should report 6.x).
- **Go 1.21+** (`go version`).
- **ffmpeg** at `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, or `/usr/bin/ffmpeg`.
- ~1 GB free disk for the Parakeet CoreML weights (downloaded on first run, cached in `~/Documents/huggingface/`).

## Build

```sh
make build
```

This runs `swift build -c release` for `fluidbatchd/` and `go build` for the service binary. First Swift build clones FluidAudio (pinned by revision in `fluidbatchd/Package.swift`) and takes ~60 s. Subsequent builds are seconds.

Outputs:

- `bin/transcriber-service` — the HTTP service.
- `fluidbatchd/.build/release/fluidbatchd` — the daemon. The service finds it automatically when run from this directory.

## Run

```sh
make run
# or:
./bin/transcriber [-addr 0.0.0.0:8080] [-data-dir ~/.transcriber] [-workers 2]
```

On first start the Swift side downloads the Parakeet weights from Hugging Face (~600 MB). Watch the log for `worker: READY\tworkers=2` — that's when the model is hot and the API is fully usable.

Foreground process; Ctrl-C / SIGTERM triggers a graceful shutdown that waits for in-flight inferences to drain.

### Flags

| Flag | Default | Notes |
|---|---|---|
| `-addr` | `0.0.0.0:8080` | LAN binding by default. Use `127.0.0.1:8080` to localhost-only. |
| `-data-dir` | `~/.transcriber` | Holds `jobs.db`, `audio/`, `transcripts/`. |
| `-fluidbatchd` | autoresolved | Override path to the Swift binary. |
| `-workers` | `2` | M4 sweet spot. M-series Pro/Max may benefit from 3. |
| `-default-language` | `ru` | Per-job override via `language` form field. Empty = auto-detect. |
| `-max-upload-bytes` | 1 GB | Caps the multipart upload size. |

## End-to-end example

```sh
# Upload (returns {"job_id":"…","status":"queued","filename":"…"})
curl -F file=@lecture.mp3 -F language=ru http://m4.local:8080/jobs

# Poll until done (status: queued → running → done)
curl http://m4.local:8080/jobs/<job_id> | jq

# Fetch transcript JSON (text + per-word timings + confidence)
curl http://m4.local:8080/jobs/<job_id>/transcript -o transcript.json

# Free up the slot
curl -X DELETE http://m4.local:8080/jobs/<job_id>
```

The MP3 is removed from the server **the moment inference finishes**. The transcript stays until you `DELETE` it — you can re-fetch as many times as you like.

## Limits and behaviour

- **Audio formats:** anything ffmpeg can decode. The service auto-converts to 16 kHz mono PCM internally; you don't need to pre-process.
- **Concurrent uploads:** OK. Excess requests sit in the SQLite queue. The Apple Neural Engine is the bottleneck, so there's no benefit beyond 2 in-flight inferences on M4 base.
- **Quality flag:** transcripts of non-Russian or chant-only audio come back with `confidence < 0.5`. Filter these for manual review.
- **Restart-safe:** killing the service mid-batch doesn't lose work. On restart, anything `running` is moved back to `queued` and re-fed to fluidbatchd.

## Documentation

- **`docs/API.md`** — full REST specification with request/response schemas, error codes, curl examples, and a 30-line client recipe. Hand this to an LLM and it can write a client from scratch.
- **`fluidbatchd/README.md`** — the Swift sub-package that does the actual ASR; describes the wire protocol the Go service speaks to it.
- **`../transcriber-mcp/`** — sibling MCP wrapper for LLM agents (Claude Code et al.). Same data plane, typed tools (`transcribe_wait`, `get_transcript`, `list_jobs`).

## License / credits

Wraps the [FluidAudio](https://github.com/FluidInference/FluidAudio) Swift package and NVIDIA Parakeet-TDT-0.6b-v3 weights (CC-BY-4.0, repackaged as CoreML by FluidInference).
