#!/usr/bin/env python3
"""
Audio denoiser with selectable strategies (`--strategy`).

  afftdn       ffmpeg adaptive FFT denoise — reduces the noise floor by `--nr`
               dB without gating pauses to dead silence. Fast, no ML deps
               (ffmpeg only). Milder than DeepFilterNet — leaves more residual.
  rnnoise      RNNoise (pyrnnoise) speech denoiser, straight output. Aggressive
               — can leave dead-silent pauses on noisy material.
  rnnoise-mix  RNNoise blended back with the original by voice probability
               (`--mix-min` in pauses, `--mix-max` on voice) — keeps a natural
               noise floor so pauses don't sound cut out.
  afftdn-rnnoise-mix
               Chain: afftdn first (tames steady noise), then RNNoise, then the
               TRUE original blended back by voice probability — afftdn does the
               bulk while the blend keeps a natural floor in pauses.
  deepfilternet
               (default) DeepFilterNet3 — a learned full-band speech denoiser. Removes
               steady tape hiss / static far better than afftdn without the
               over-gating artefacts of RNNoise, and preserves the voice (no
               generative hallucination). Runs real-time on CPU (no GPU/CUDA),
               so it works on the service and Apple Silicon alike. Uses the
               standalone `deep-filter` binary (no torch / no Python ML deps);
               set $DEEP_FILTER_BIN, put it on PATH, or drop it next to this
               script. Binaries: github.com/Rikorose/DeepFilterNet releases.

All strategies output mono 128 kbps MP3 (matching the canonical original). The
app's original↔clean slider does the user-facing blend; this only produces the
clean file. The rnnoise* strategies need pyrnnoise/numpy/scipy/pydub/soundfile;
afftdn needs only ffmpeg.
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

STRATEGIES = ("afftdn", "rnnoise", "rnnoise-mix", "afftdn-rnnoise-mix", "deepfilternet")
DEFAULT_STRATEGY = "deepfilternet"

# afftdn knobs
DEFAULT_NR = 12.0   # noise reduction (dB), higher = more aggressive
DEFAULT_NF = -25.0  # noise floor (dB)

# rnnoise-mix knobs (ratio of ORIGINAL blended back)
DEFAULT_MIX_MIN = 0.10  # in pauses (no voice)
DEFAULT_MIX_MAX = 0.25  # on voice

SAMPLE_RATE = 48000  # RNNoise native rate

# Final loudness stage applied after denoise: speechnorm gently pulls up quiet
# speech (less pumping than dynaudnorm), then loudnorm hits a consistent
# broadcast target (−16 LUFS, true-peak −1.5 dB) across the whole corpus.
# Applied in the same encode as the denoise output (no double mp3 pass).
NORMALIZE_FILTER = "speechnorm=e=12.5:r=0.0001:l=1,loudnorm=I=-16:TP=-1.5:LRA=11"


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


# ──────────────────────────── DeepFilterNet ────────────────────────────────

def _resolve_deep_filter_bin():
    """Locate the standalone `deep-filter` binary (DeepFilterNet3, no torch):
    $DEEP_FILTER_BIN, then PATH, then a copy sitting next to this script."""
    cand = os.environ.get("DEEP_FILTER_BIN") or shutil.which("deep-filter")
    if not cand:
        sibling = Path(__file__).resolve().parent / "deep-filter"
        if sibling.exists():
            cand = str(sibling)
    if not cand or not Path(cand).exists():
        raise RuntimeError(
            "deep-filter binary not found — set DEEP_FILTER_BIN, put it on PATH, "
            "or drop it next to denoise_mp3.py "
            "(github.com/Rikorose/DeepFilterNet releases)."
        )
    return cand


def _run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
        raise RuntimeError(f"{cmd[0]} failed ({proc.returncode}): {tail}")


def _dfn_enhance_to_wav(in_path, out_wav):
    """DeepFilterNet3 via the standalone `deep-filter` Rust binary — no torch,
    no Python ML deps, CPU-only, model weights embedded. Decode → 48k mono wav
    → deep-filter → 48k mono wav. No loudness normalization (the caller decides
    whether/when to normalize)."""
    bin_path = _resolve_deep_filter_bin()
    with tempfile.TemporaryDirectory() as td:
        wav_in = os.path.join(td, "in.wav")
        outdir = os.path.join(td, "out")
        os.makedirs(outdir, exist_ok=True)
        # DeepFilterNet operates at 48 kHz.
        _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
              "-ac", "1", "-ar", "48000", wav_in])
        # deep-filter writes <basename>.wav into --output-dir (separate dir so
        # it can't clobber the input).
        _run([bin_path, "--output-dir", outdir, wav_in])
        wav_out = os.path.join(outdir, "in.wav")
        if not os.path.exists(wav_out):
            raise RuntimeError("deep-filter produced no output")
        shutil.copyfile(wav_out, out_wav)


def _denoise_deepfilternet(in_path, out_path):
    """deep-filter enhance → loudness-normalized mono 128k mp3 (single encode)."""
    with tempfile.TemporaryDirectory() as td:
        enhanced = os.path.join(td, "enhanced.wav")
        _dfn_enhance_to_wav(in_path, enhanced)
        _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", enhanced,
              "-af", NORMALIZE_FILTER,
              "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(out_path)])


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
    elif strategy == "deepfilternet":
        _denoise_deepfilternet(in_path, out_path)
    else:
        raise ValueError(f"unknown strategy: {strategy!r} (one of {STRATEGIES})")


# ──────────────────────────── segment plan (splice) ────────────────────────
#
# Some recordings carry sung kirtan / recited Sanskrit at the edges (or mid-talk)
# that DeepFilterNet — a speech model — mangles, because it treats the singing as
# noise to suppress. A plan splits the timeline into a contiguous partition of
# segments, each cleaned with its OWN strategy (afftdn for kirtan, deepfilternet
# for speech, "copy" for raw), then concatenated. Loudness is applied ONCE over
# the whole spliced file so the seams don't jump in level.

PLAN_STRATEGIES = STRATEGIES + ("copy",)  # "copy" = passthrough (no denoise)


def _probe_duration_ms(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return int(round(float(out.stdout.strip()) * 1000))
    except ValueError:
        return 0


def _segment_to_wav(in_path, out_wav, strategy, nr, nf, mix_min, mix_max):
    """Denoise one already-cut segment to a 48k mono WAV, WITHOUT loudness
    normalization (applied once over the whole spliced file). 'copy' passes the
    audio through untouched."""
    if strategy == "copy":
        _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
              "-ac", "1", "-ar", str(SAMPLE_RATE), str(out_wav)])
    elif strategy == "afftdn":
        af = f"afftdn=nr={nr}:nf={nf},alimiter=limit=0.95"
        _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", str(in_path),
              "-af", af, "-ac", "1", "-ar", str(SAMPLE_RATE), str(out_wav)])
    elif strategy == "deepfilternet":
        _dfn_enhance_to_wav(in_path, out_wav)
    elif strategy in ("rnnoise", "rnnoise-mix", "afftdn-rnnoise-mix"):
        # These strategies only emit mp3; re-decode to the common 48k wav.
        with tempfile.TemporaryDirectory() as td:
            seg_mp3 = os.path.join(td, "seg.mp3")
            denoise_one(in_path, seg_mp3, strategy, nr, nf, mix_min, mix_max)
            _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", seg_mp3,
                  "-ac", "1", "-ar", str(SAMPLE_RATE), str(out_wav)])
    else:
        raise ValueError(f"unknown strategy: {strategy!r} (one of {PLAN_STRATEGIES})")


def _concat_wavs(wavs, out_wav, crossfade_ms):
    """Concatenate same-format (48k mono) WAVs. With crossfade_ms>0 the seams are
    blended with an equal-power crossfade; otherwise hard-concatenated."""
    if len(wavs) == 1:
        shutil.copyfile(wavs[0], out_wav)
        return
    inputs = []
    for w in wavs:
        inputs += ["-i", w]
    if crossfade_ms and crossfade_ms > 0:
        d = crossfade_ms / 1000.0
        cur = "[0:a]"
        fc = ""
        for idx in range(1, len(wavs)):
            label = "[out]" if idx == len(wavs) - 1 else f"[a{idx}]"
            fc += f"{cur}[{idx}:a]acrossfade=d={d}:c1=tri:c2=tri{label};"
            cur = f"[a{idx}]"
        fc = fc.rstrip(";")
    else:
        fc = "".join(f"[{i}:a]" for i in range(len(wavs))) + \
            f"concat=n={len(wavs)}:v=0:a=1[out]"
    _run(["ffmpeg", "-hide_banner", "-nostats", "-y", *inputs,
          "-filter_complex", fc, "-map", "[out]", str(out_wav)])


def denoise_plan(in_path, out_path, segments, crossfade_ms=120, normalize=True,
                 default_nr=DEFAULT_NR, default_nf=DEFAULT_NF,
                 default_mix_min=DEFAULT_MIX_MIN, default_mix_max=DEFAULT_MIX_MAX):
    """Splice-denoise: cut each segment from in_path, clean it with its own
    strategy to a 48k mono WAV, concat (optionally crossfaded), then apply ONE
    loudness pass over the whole and encode mono 128k mp3.

    `segments`: ordered list of dicts {start_ms, end_ms?, strategy, nr?, nf?}.
    Must form a contiguous partition (gaps/overlaps > 50 ms raise); a missing
    end_ms on the last segment means "to end of file"."""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    if not segments:
        raise ValueError("plan has no segments")
    total_ms = _probe_duration_ms(in_path)
    segs = sorted(segments, key=lambda s: int(s["start_ms"]))
    prev_end = 0
    norm = []
    for s in segs:
        start = int(s["start_ms"])
        end = int(s["end_ms"]) if s.get("end_ms") is not None else total_ms
        if start < prev_end - 50:
            raise ValueError(f"segments overlap near {start}ms")
        if start > prev_end + 50:
            raise ValueError(
                f"gap before {start}ms (prev end {prev_end}ms) — plan must be a "
                "contiguous partition")
        if end <= start:
            raise ValueError(f"empty segment {start}-{end}ms")
        norm.append((start, end, s))
        prev_end = end

    with tempfile.TemporaryDirectory() as td:
        wavs = []
        for i, (start, end, s) in enumerate(norm):
            cut = os.path.join(td, f"cut_{i}.wav")
            _run(["ffmpeg", "-hide_banner", "-nostats", "-y",
                  "-ss", f"{start / 1000:.3f}", "-to", f"{end / 1000:.3f}",
                  "-i", str(in_path), "-ac", "1", "-ar", str(SAMPLE_RATE), cut])
            den = os.path.join(td, f"den_{i}.wav")
            _segment_to_wav(
                cut, den, s.get("strategy", DEFAULT_STRATEGY),
                float(s.get("nr", default_nr)), float(s.get("nf", default_nf)),
                default_mix_min, default_mix_max)
            wavs.append(den)
        joined = os.path.join(td, "joined.wav")
        _concat_wavs(wavs, joined, crossfade_ms)
        af = NORMALIZE_FILTER if normalize else "anull"
        _run(["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", joined,
              "-af", af, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k",
              str(out_path)])


def _load_plan(raw):
    """Plan from a JSON file path or an inline JSON string."""
    if os.path.isfile(raw):
        with open(raw) as f:
            return json.load(f)
    return json.loads(raw)


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
    parser.add_argument("--plan", default=None,
                        help="Segment-plan (splice) mode: JSON file path or inline "
                             "JSON {\"segments\":[{start_ms,end_ms?,strategy,nr?,nf?}],"
                             " \"crossfade_ms\":120, \"normalize\":true}. Requires "
                             "--in/--out; overrides --strategy. Each segment is "
                             "cleaned with its own strategy and the parts are spliced "
                             "with one final loudness pass.")
    args = parser.parse_args()

    if args.plan:
        if not (args.in_path and args.out_path):
            parser.error("--plan requires --in and --out")
        plan = _load_plan(args.plan)
        denoise_plan(args.in_path, args.out_path, plan["segments"],
                     crossfade_ms=int(plan.get("crossfade_ms", 120)),
                     normalize=bool(plan.get("normalize", True)),
                     default_nr=args.nr, default_nf=args.nf,
                     default_mix_min=args.mix_min, default_mix_max=args.mix_max)
        return

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
