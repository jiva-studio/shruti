# share-video-backgrounds

Download a video by URL, cut it into reel-format clips, and upload them to the S3
backgrounds catalog consumed by `modules/services/share-video`.

Each clip is stored at:

```
s3://$BUCKET/private/share/video/backgrounds/<theme>/<uuid>.mp4
```

The tool drops audio — clips are background plates; the reels generator overlays its own.
Tail shorter than one clip is dropped.

## Codec normalisation

Every clip is re-encoded with identical parameters so a pack can be stitched by
ffmpeg's concat demuxer without re-encoding:

- `libx264` `high@4.0`, `yuv420p`
- fixed fps (default `30`, `--fps` to override)
- GOP locked (`-g 2×fps`, `-keyint_min 2×fps`, `-sc_threshold 0`)
- no audio (`-an`)
- vertical mode also pins resolution to `width×height`

`original` mode normalises codec/fps but keeps source resolution, so it is
concat-safe only if every clip in the theme came from a same-resolution source.

## Prerequisites

- Python 3.10+
- `ffmpeg` / `ffprobe` on `PATH`
- AWS credentials in the standard chain (env, profile, IAM role)
- Bucket name in `BUCKET` env (or pass `--bucket`)

## Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

```bash
# default: 5-second vertical 1080×1920 clips
BUCKET=my-bucket python3 main.py "https://www.youtube.com/watch?v=…" --theme nature

# custom clip length and frame
python3 main.py "<url>" --theme sky --clip-seconds 7 --width 720 --height 1280

# keep source frame instead of vertical crop
python3 main.py "<url>" --theme raw --format original

# preview locally without uploading
python3 main.py "<url>" --theme test --keep-local ./work --dry-run
```

## Options

| Flag | Default | Description |
|---|---|---|
| `url` (positional) | — | Any URL `yt-dlp` accepts (YouTube, Vimeo, direct .mp4, …) |
| `--theme` | **required** | Subfolder under the prefix |
| `--clip-seconds` | `5` | Clip length in seconds |
| `--width` | `1080` | Output frame width (vertical mode) |
| `--height` | `1920` | Output frame height (vertical mode) |
| `--fps` | `30` | Output frame rate (must match across a pack) |
| `--format` | `vertical` | `vertical` = scale-to-cover + center-crop; `original` = keep source frame |
| `--bucket` | `$BUCKET` | Target S3 bucket |
| `--prefix` | `private/share/video/backgrounds` | Key prefix |
| `--keep-local` | — | Directory to also keep cut clips locally as `001.mp4`, `002.mp4`, … |
| `--dry-run` | off | Cut clips but skip the upload |
