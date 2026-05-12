# fluidbatchd

Long-running [FluidAudio](https://github.com/FluidInference/FluidAudio) Parakeet-TDT-0.6b-v3 transcriber daemon. Loads CoreML models on the Apple Neural Engine once, then accepts file paths on stdin and writes JSON transcripts to a configurable output directory.

This is a sub-package of `transcriber`. The Go service (`../cmd/transcriber`) spawns one `fluidbatchd` process at startup and feeds it MP3 paths as users upload files.

## Build

Requires Swift 6 (macOS 14+) and `ffmpeg` available at one of `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `/usr/bin/ffmpeg`. CoreML weights (~600 MB) are downloaded from Hugging Face on first run and cached.

```sh
swift build -c release
./.build/release/fluidbatchd --help
```

## Wire protocol

**Stdin** — one job per line, optional language override:

```
/path/to/audio1.mp3
/path/to/audio2.mp3<TAB>en
```

The daemon uses `basename(path)` (without extension) as `job_id`. Empty language code → auto-detect.

**Stderr** — TSV lifecycle events:

```
READY<TAB>workers=2
OK<TAB>job_id=…<TAB>worker=N<TAB>proc=…<TAB>dur=…<TAB>conf=…<TAB>rtfx=…
FAIL<TAB>job_id=…<TAB>worker=N<TAB>error=<single-line, escaped>
```

`error` values escape `\\`, `\t`, `\n` to keep one event per line.

**Output** — `<output-dir>/<job_id>.json`, schema:

```json
{
  "audioFile": "/path/...",
  "mode": "batch",
  "modelVersion": "v3",
  "text": "…",
  "durationSeconds": 1817.5,
  "processingTimeSeconds": 4.85,
  "rtfx": 374.3,
  "confidence": 0.94,
  "wordTimings": [
    {"word":"Лекция","startTime":4.24,"endTime":4.64,"confidence":0.999},
    …
  ]
}
```

## Why ffmpeg pre-conversion is built in

FluidAudio's internal `AudioConverter` mishandles 22050 Hz / stereo MP3s and produces garbage tokens (`confidence ≈ 0.2`). Every input is therefore decoded to 16 kHz mono PCM WAV via a temp file before inference. The cost is ≈ 0.5 s per 30-min file and runs concurrently with the other worker's ANE inference, so it does not bottleneck.

## Tuning

Measured on Apple M4 base with `--workers 2` (sweet spot for shared ANE):

| Concurrency | Per-file wall (30:17 input) | Aggregate × realtime |
|---|---|---|
| 1 | 5.15 s | 353× |
| 2 | 4.29 s | 423× |
| 3 | 4.62 s | 393× |
| 4 | 5.11 s | 355× |

Going past 2 contends on the single ANE block and gives no benefit. Re-measure on M-series Pro/Max.

## License / credits

Wraps the FluidAudio Swift package (see upstream LICENSE) and NVIDIA Parakeet-TDT-0.6b-v3 weights (CC-BY-4.0, redistributed by FluidInference for CoreML).
