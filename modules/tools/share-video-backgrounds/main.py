#!/usr/bin/env python3
"""Download a video by URL, cut it into reel-format clips, upload to S3 backgrounds catalog.

Default geometry is 9:16 1080x1920 (vertical reel). Audio is intentionally dropped —
these clips are background plates consumed by the share-video reel generator, which
overlays its own audio. Each clip gets a fresh UUID name in S3; re-runs accumulate.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

import boto3
import yt_dlp


DEFAULT_PREFIX = "private/share/video/backgrounds"
DEFAULT_CLIP_SECONDS = 5.0
DEFAULT_WIDTH = 1080
DEFAULT_HEIGHT = 1920
DEFAULT_FPS = 30


def download(url: str, dest_dir: Path) -> Path:
    """Download best available video into dest_dir as source.mp4."""
    out_template = str(dest_dir / "source.%(ext)s")
    opts = {
        "outtmpl": out_template,
        "format": "bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(info))
        if path.suffix.lower() != ".mp4":
            mp4 = path.with_suffix(".mp4")
            if mp4.exists():
                path = mp4
        return path


def probe_duration(path: Path) -> float:
    out = subprocess.check_output([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json", str(path),
    ])
    return float(json.loads(out)["format"]["duration"])


def cut_clip(
    src: Path,
    dst: Path,
    start: float,
    duration: float,
    width: int,
    height: int,
    fps: int,
    mode: str,
) -> None:
    """Cut [start, start+duration] from src to dst, normalised for concat-demuxer.

    Every clip is re-encoded with identical codec parameters so a pack of clips
    can be stitched together by ffmpeg's concat demuxer without re-encoding:
    libx264 high@4.0, yuv420p, fixed fps, fixed GOP, no audio. In vertical mode
    the frame is also locked to width×height; in original mode only fps/codec
    are normalised — that mode is concat-safe only if every clip in the theme
    comes from a same-resolution source.
    """
    if mode == "vertical":
        vf = (
            f"fps={fps},"
            f"scale='if(gt(a,{width}/{height}),-2,{width})':"
            f"'if(gt(a,{width}/{height}),{height},-2)',"
            f"crop={width}:{height}"
        )
    elif mode == "original":
        vf = f"fps={fps}"
    else:
        raise ValueError(f"unknown format mode: {mode}")

    cmd = [
        "ffmpeg", "-nostdin", "-y",
        "-ss", f"{start:.3f}",
        "-i", str(src),
        "-t", f"{duration:.3f}",
        "-an",
        "-vf", vf,
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.0",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-crf", "20",
        "-g", str(fps * 2),
        "-keyint_min", str(fps * 2),
        "-sc_threshold", "0",
        "-movflags", "+faststart",
        "-loglevel", "error",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def upload(client, bucket: str, key: str, path: Path) -> None:
    client.upload_file(
        str(path), bucket, key,
        ExtraArgs={"ContentType": "video/mp4"},
    )


def main() -> int:
    p = argparse.ArgumentParser(
        description="Download a video, cut it into reel-format clips, upload to S3.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("url", nargs="?",
                   help="Source video URL (anything yt-dlp supports). Omit when using --upload-from.")
    p.add_argument("--theme", required=True,
                   help="Subfolder under the backgrounds prefix")
    p.add_argument("--upload-from", default=None,
                   help="Upload existing pre-cut .mp4 files from this dir instead of downloading/cutting")
    p.add_argument("--clip-seconds", type=float, default=DEFAULT_CLIP_SECONDS,
                   help="Clip length in seconds")
    p.add_argument("--width", type=int, default=DEFAULT_WIDTH,
                   help="Output frame width (vertical mode)")
    p.add_argument("--height", type=int, default=DEFAULT_HEIGHT,
                   help="Output frame height (vertical mode)")
    p.add_argument("--fps", type=int, default=DEFAULT_FPS,
                   help="Output frame rate (all clips in a pack must match)")
    p.add_argument("--format", dest="fmt", choices=["vertical", "original"],
                   default="vertical",
                   help="vertical = scale+center-crop to width×height; original = keep source frame")
    p.add_argument("--bucket", default=os.environ.get("BUCKET"),
                   help="Target S3 bucket (defaults to env BUCKET)")
    p.add_argument("--prefix", default=DEFAULT_PREFIX,
                   help="Key prefix under the bucket")
    p.add_argument("--keep-local", default=None,
                   help="Directory to also keep cut clips locally (numbered 001.mp4…)")
    p.add_argument("--dry-run", action="store_true",
                   help="Cut clips but skip the S3 upload")
    args = p.parse_args()

    if not args.bucket and not args.dry_run:
        print("error: --bucket or env BUCKET is required (or use --dry-run)",
              file=sys.stderr)
        return 2
    if args.clip_seconds <= 0:
        print("error: --clip-seconds must be > 0", file=sys.stderr)
        return 2
    if not args.url and not args.upload_from:
        print("error: provide a URL or --upload-from <dir>", file=sys.stderr)
        return 2

    keep_dir = Path(args.keep_local).resolve() if args.keep_local else None
    if keep_dir:
        keep_dir.mkdir(parents=True, exist_ok=True)

    s3 = None if args.dry_run else boto3.client("s3")
    prefix = args.prefix.strip("/")

    if args.upload_from:
        src_dir = Path(args.upload_from).resolve()
        clips = sorted(src_dir.glob("*.mp4"))
        if not clips:
            print(f"error: no .mp4 files in {src_dir}", file=sys.stderr)
            return 1
        print(f"→ uploading {len(clips)} pre-cut clips from {src_dir}")
        for i, local in enumerate(clips, start=1):
            clip_uuid = uuid.uuid4().hex
            key = f"{prefix}/{args.theme}/{clip_uuid}.mp4"
            if args.dry_run:
                print(f"  [{i}/{len(clips)}] DRY-RUN s3://{args.bucket or '<bucket>'}/{key}")
                continue
            upload(s3, args.bucket, key, local)
            print(f"  [{i}/{len(clips)}] s3://{args.bucket}/{key}")
        print("done.")
        return 0

    with tempfile.TemporaryDirectory(prefix="svb-") as tmp_str:
        tmp = Path(tmp_str)
        print(f"→ downloading {args.url}")
        src = download(args.url, tmp)
        total = probe_duration(src)
        n = int(total // args.clip_seconds)
        if n == 0:
            print(
                f"source is shorter than clip length "
                f"({total:.1f}s < {args.clip_seconds}s)",
                file=sys.stderr,
            )
            return 1

        print(f"→ source duration {total:.1f}s → {n} clips of {args.clip_seconds}s")
        for i in range(n):
            local = tmp / f"{i + 1:03d}.mp4"
            cut_clip(
                src, local,
                start=i * args.clip_seconds,
                duration=args.clip_seconds,
                width=args.width, height=args.height, fps=args.fps,
                mode=args.fmt,
            )

            if keep_dir:
                shutil.copy2(local, keep_dir / local.name)

            clip_uuid = uuid.uuid4().hex
            key = f"{prefix}/{args.theme}/{clip_uuid}.mp4"

            if args.dry_run:
                print(f"  [{i + 1}/{n}] DRY-RUN s3://{args.bucket or '<bucket>'}/{key}")
                continue
            upload(s3, args.bucket, key, local)
            print(f"  [{i + 1}/{n}] s3://{args.bucket}/{key}")

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
