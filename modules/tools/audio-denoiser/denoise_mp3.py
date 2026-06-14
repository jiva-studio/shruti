#!/usr/bin/env python3
"""
Audio denoiser with selectable strategies (`--strategy`).

  afftdn       (default) ffmpeg adaptive FFT denoise — reduces the noise floor
               by `--nr` dB without gating pauses to dead silence. Fast, no ML
               deps (ffmpeg only). Sounded the cleanest on archival lectures.
  rnnoise      RNNoise (pyrnnoise) speech denoiser, straight output. Aggressive
               — can leave dead-silent pauses on noisy material.
  rnnoise-mix  RNNoise blended back with the original by voice probability
               (`--mix-min` in pauses, `--mix-max` on voice) — keeps a natural
               noise floor so pauses don't sound cut out.

All strategies output mono 128 kbps MP3 (matching the canonical original). The
app's original↔clean slider does the user-facing blend; this only produces the
clean file. The rnnoise* strategies need pyrnnoise/numpy/scipy/pydub/soundfile;
afftdn needs only ffmpeg.
"""

import argparse
import os
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

STRATEGIES = ("afftdn", "rnnoise", "rnnoise-mix", "afftdn-rnnoise-mix")
DEFAULT_STRATEGY = "afftdn"

# afftdn knobs
DEFAULT_NR = 12.0   # noise reduction (dB), higher = more aggressive
DEFAULT_NF = -25.0  # noise floor (dB)

# rnnoise-mix knobs (ratio of ORIGINAL blended back)
DEFAULT_MIX_MIN = 0.10  # in pauses (no voice)
DEFAULT_MIX_MAX = 0.25  # on voice

SAMPLE_RATE = 48000  # RNNoise native rate


# ─────────────────────────────── afftdn ────────────────────────────────────

def _denoise_afftdn(in_path, out_path, nr, nf):
    """One ffmpeg pass: afftdn denoise + a safety limiter, mono 128k."""
    af = f"afftdn=nr={nr}:nf={nf},alimiter=limit=0.95"
    cmd = [
        "ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
        "-af", af, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(out_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"ffmpeg afftdn failed ({proc.returncode}): {tail}")


# ─────────────────────────────── RNNoise ───────────────────────────────────

def smooth_mix_audio(
    original,
    processed,
    voice_probabilities,
    min_mix_ratio: float,
    max_mix_ratio: float,
    transition_ms: int = 50,
    sample_rate: int = SAMPLE_RATE,
):
    """
    Mix original and processed audio using RNNoise voice probability detection.

    - No voice (0% probability): Uses min_mix_ratio
    - Full voice (100% probability): Uses max_mix_ratio
    - Partial voice: Linear interpolation between min and max
    - Smooth transitions: Gaussian filtering prevents harsh jumps
    """
    import numpy as np
    from scipy.ndimage import gaussian_filter1d

    original_float = original.astype(np.float32)
    processed_float = processed.astype(np.float32)
    transition_samples = int(transition_ms * sample_rate / 1000)

    # RNNoise processes in 480-sample frames (10ms at 48kHz)
    FRAME_SIZE = 480

    mix_envelope = np.zeros(len(original_float))
    for i, voice_prob in enumerate(voice_probabilities):
        start = i * FRAME_SIZE
        end = min(start + FRAME_SIZE, len(mix_envelope))
        # voice_prob 0 -> min_mix_ratio (more original in pauses);
        # voice_prob 1 -> max_mix_ratio.
        mix_envelope[start:end] = min_mix_ratio + (max_mix_ratio - min_mix_ratio) * voice_prob

    if transition_samples > 0:
        mix_envelope = gaussian_filter1d(mix_envelope, sigma=transition_samples / 3)

    mixed = mix_envelope * original_float + (1.0 - mix_envelope) * processed_float
    return mixed.astype(np.int16)


def _load_int16_mono(path):
    """Load an audio file as a mono 48k int16 numpy array (RNNoise's format)."""
    from pydub import AudioSegment
    import numpy as np

    audio = AudioSegment.from_file(str(path))
    if audio.channels > 1:
        audio = audio.set_channels(1)
    if audio.frame_rate != SAMPLE_RATE:
        audio = audio.set_frame_rate(SAMPLE_RATE)
    audio = audio.set_sample_width(2)
    return np.array(audio.get_array_of_samples(), dtype=np.int16)


def _denoise_rnnoise(in_path, out_path, mix=False,
                     mix_min=DEFAULT_MIX_MIN, mix_max=DEFAULT_MIX_MAX,
                     mix_reference=None):
    """RNNoise denoise (mono 48k), optionally blended back by voice probability.

    `mix_reference` is what gets blended in (defaults to `in_path`). For the
    chained strategy it's the TRUE original, while `in_path` is the afftdn-cleaned
    intermediate — so the blend reintroduces a natural floor from the original,
    not from the intermediate. Exports 128k mp3.
    """
    from pyrnnoise import RNNoise
    from pydub import AudioSegment
    import soundfile as sf
    import numpy as np

    audio_data = _load_int16_mono(in_path)

    denoiser = RNNoise(sample_rate=SAMPLE_RATE)
    frames, probs = [], []
    for speech_prob, frame in denoiser.denoise_chunk(audio_data, partial=True):
        frames.append(frame)
        probs.append(speech_prob)
    if not frames:
        raise ValueError("No audio frames were denoised")
    out_data = np.concatenate([f.flatten() for f in frames])

    if mix:
        ref = _load_int16_mono(mix_reference) if mix_reference else audio_data
        n = min(len(ref), len(out_data))
        out_data = smooth_mix_audio(
            ref[:n], out_data[:n], np.array(probs),
            mix_min, mix_max, sample_rate=SAMPLE_RATE,
        )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as to_:
        temp_out = to_.name
    try:
        sf.write(temp_out, out_data, SAMPLE_RATE, subtype="PCM_16")
        AudioSegment.from_wav(temp_out).export(str(out_path), format="mp3", bitrate="128k")
    finally:
        if os.path.exists(temp_out):
            os.unlink(temp_out)


def _denoise_afftdn_rnnoise_mix(in_path, out_path, nr, nf, mix_min, mix_max):
    """Chain: afftdn (gentle FFT clean) → RNNoise → blend the TRUE original back
    by voice probability. afftdn first tames steady noise; RNNoise then handles
    the rest; the original blended into pauses keeps a natural floor."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
        pre = tf.name
    try:
        _denoise_afftdn(in_path, pre, nr, nf)
        _denoise_rnnoise(pre, out_path, mix=True, mix_min=mix_min, mix_max=mix_max,
                         mix_reference=in_path)
    finally:
        if os.path.exists(pre):
            os.unlink(pre)


# ─────────────────────────────── dispatch ──────────────────────────────────

def denoise_one(in_path, out_path, strategy=DEFAULT_STRATEGY,
                nr=DEFAULT_NR, nf=DEFAULT_NF,
                mix_min=DEFAULT_MIX_MIN, mix_max=DEFAULT_MIX_MAX):
    """Denoise one file with the chosen strategy. Raises on failure."""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    if strategy == "afftdn":
        _denoise_afftdn(in_path, out_path, nr, nf)
    elif strategy == "rnnoise":
        _denoise_rnnoise(in_path, out_path, mix=False)
    elif strategy == "rnnoise-mix":
        _denoise_rnnoise(in_path, out_path, mix=True, mix_min=mix_min, mix_max=mix_max)
    elif strategy == "afftdn-rnnoise-mix":
        _denoise_afftdn_rnnoise_mix(in_path, out_path, nr, nf, mix_min, mix_max)
    else:
        raise ValueError(f"unknown strategy: {strategy!r} (one of {STRATEGIES})")


def _process(args):
    in_file, out_file, strategy, nr, nf, mix_min, mix_max = args
    try:
        denoise_one(in_file, out_file, strategy, nr, nf, mix_min, mix_max)
        return (in_file, True, None)
    except Exception as e:  # noqa: BLE001
        return (in_file, False, str(e))


def find_and_process_files(root_dir=".", strategy=DEFAULT_STRATEGY,
                           nr=DEFAULT_NR, nf=DEFAULT_NF,
                           mix_min=DEFAULT_MIX_MIN, mix_max=DEFAULT_MIX_MAX, workers=1):
    """Recursively find 'original.mp3' files and denoise each to 'clean.mp3'."""
    root = Path(root_dir).resolve()
    originals = sorted(root.rglob("original.mp3"))
    tasks = [(f, f.parent / "clean.mp3", strategy, nr, nf, mix_min, mix_max) for f in originals]
    total, done = len(tasks), 0
    if workers == 1:
        for task in tasks:
            in_file, ok, err = _process(task)
            done += 1
            print(f"[{done}/{total}] {in_file} {'ok' if ok else 'FAIL: ' + str(err)}")
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            futures = {ex.submit(_process, t): t for t in tasks}
            for fut in as_completed(futures):
                in_file, ok, err = fut.result()
                done += 1
                print(f"[{done}/{total}] {in_file} {'ok' if ok else 'FAIL: ' + str(err)}")


def main():
    parser = argparse.ArgumentParser(
        description="Denoise audio with a selectable strategy. Single-file "
                    "(--in/--out) or recursive (original.mp3 → clean.mp3).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  denoise_mp3.py -i in.mp3 -o clean.mp3                      # afftdn (default)
  denoise_mp3.py -i in.mp3 -o clean.mp3 --strategy rnnoise
  denoise_mp3.py -i in.mp3 -o clean.mp3 --strategy rnnoise-mix --mix-min 0.1 --mix-max 0.25
  denoise_mp3.py --root-dir /path --workers 4 --nr 18
        """,
    )
    parser.add_argument("--root-dir", default=".",
                        help="Root to search for original.mp3 (default: cwd)")
    parser.add_argument("-i", "--in", dest="in_path", default=None,
                        help="Single-file mode: input path (requires --out).")
    parser.add_argument("-o", "--out", dest="out_path", default=None,
                        help="Single-file mode: output path (requires --in).")
    parser.add_argument("--strategy", choices=STRATEGIES, default=DEFAULT_STRATEGY,
                        help=f"Cleaning strategy (default {DEFAULT_STRATEGY}).")
    parser.add_argument("--nr", type=float, default=DEFAULT_NR,
                        help=f"afftdn: noise reduction in dB (default {DEFAULT_NR}).")
    parser.add_argument("--nf", type=float, default=DEFAULT_NF,
                        help=f"afftdn: noise floor in dB (default {DEFAULT_NF}).")
    parser.add_argument("--mix-min", type=float, default=DEFAULT_MIX_MIN,
                        help=f"rnnoise-mix: original ratio in pauses (default {DEFAULT_MIX_MIN}).")
    parser.add_argument("--mix-max", type=float, default=DEFAULT_MIX_MAX,
                        help=f"rnnoise-mix: original ratio on voice (default {DEFAULT_MIX_MAX}).")
    parser.add_argument("-w", "--workers", type=int, default=1,
                        help="Parallel workers for recursive mode (default 1).")
    args = parser.parse_args()

    if args.in_path or args.out_path:
        if not (args.in_path and args.out_path):
            parser.error("--in and --out must be used together")
        denoise_one(args.in_path, args.out_path, args.strategy,
                    args.nr, args.nf, args.mix_min, args.mix_max)
        return

    find_and_process_files(args.root_dir, args.strategy, args.nr, args.nf,
                           args.mix_min, args.mix_max, args.workers)


if __name__ == "__main__":
    main()
