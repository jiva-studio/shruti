#!/usr/bin/env python3
"""
MP3 Audio Denoiser using Spectral Subtraction and RNNoise

Removes noise from MP3 files with a multi-stage processing pipeline:
- Optional spectral subtraction using custom noise profile
- Intelligent denoising via RNNoise
- Dynamic volume normalization
- Smooth crossfading between original and processed audio
"""

import argparse
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

from pydub import AudioSegment
from pyrnnoise import RNNoise
import soundfile as sf
import numpy as np
from scipy import signal
from tqdm import tqdm


def load_noise_profile(noise_profile_path: str, target_sample_rate: int = 48000) -> np.ndarray:
    """
    Load and analyze noise profile from a WAV file.

    Args:
        noise_profile_path: Path to noise profile WAV file
        target_sample_rate: Target sample rate to resample to

    Returns:
        Noise spectrum (magnitude) for spectral subtraction
    """
    noise_data, noise_sr = sf.read(noise_profile_path, dtype='float32')

    # Convert to mono if stereo
    if len(noise_data.shape) > 1:
        noise_data = noise_data.mean(axis=1)

    # Resample if needed
    if noise_sr != target_sample_rate:
        num_samples = int(len(noise_data) * target_sample_rate / noise_sr)
        noise_data = signal.resample(noise_data, num_samples)

    # Compute noise spectrum using FFT
    noise_fft = np.fft.rfft(noise_data)
    noise_magnitude = np.abs(noise_fft)

    return noise_magnitude


def spectral_subtraction(
    audio_data: np.ndarray,
    noise_profile: np.ndarray,
    sample_rate: int = 48000,
    frame_length: int = 2048,
    hop_length: int = 512,
    noise_factor: float = 1.5,
    floor_factor: float = 0.002
) -> np.ndarray:
    """
    Apply spectral subtraction using a noise profile.

    This removes noise by subtracting the noise spectrum from the signal spectrum
    in the frequency domain, then reconstructing the time-domain signal.

    Args:
        audio_data: Input audio as float32 numpy array (normalized -1 to 1)
        noise_profile: Noise magnitude spectrum from load_noise_profile()
        sample_rate: Audio sample rate
        frame_length: FFT window size (default: 2048)
        hop_length: Hop size between frames (default: 512)
        noise_factor: How aggressively to subtract noise (default: 1.5)
        floor_factor: Minimum signal floor to prevent over-subtraction (default: 0.002)

    Returns:
        Denoised audio as float32 numpy array
    """
    # Ensure audio is float32
    audio_float = audio_data.astype(np.float32)

    # Create output buffer
    output = np.zeros_like(audio_float)
    window = signal.windows.hann(frame_length)

    # Normalize noise profile to match frame length
    noise_profile_normalized = signal.resample(noise_profile, frame_length // 2 + 1)

    # Process in overlapping frames
    num_frames = (len(audio_float) - frame_length) // hop_length + 1

    for i in range(num_frames):
        start = i * hop_length
        end = start + frame_length

        if end > len(audio_float):
            break

        # Extract frame and apply window
        frame = audio_float[start:end] * window

        # FFT to frequency domain
        frame_fft = np.fft.rfft(frame)
        magnitude = np.abs(frame_fft)
        phase = np.angle(frame_fft)

        # Spectral subtraction: subtract noise spectrum
        cleaned_magnitude = magnitude - (noise_factor * noise_profile_normalized)

        # Apply floor to prevent negative values and musical noise
        floor = floor_factor * magnitude
        cleaned_magnitude = np.maximum(cleaned_magnitude, floor)

        # Reconstruct with original phase
        cleaned_fft = cleaned_magnitude * np.exp(1j * phase)

        # IFFT back to time domain
        cleaned_frame = np.fft.irfft(cleaned_fft, n=frame_length)

        # Overlap-add
        output[start:end] += cleaned_frame * window

    # Normalize by window overlap
    normalization = np.zeros_like(audio_float)
    for i in range(num_frames):
        start = i * hop_length
        end = start + frame_length
        if end > len(audio_float):
            break
        normalization[start:end] += window ** 2

    normalization[normalization < 1e-8] = 1.0
    output /= normalization

    return output


def _measure_lufs(path):
    """Integrated loudness (LUFS) of a file via ffmpeg's EBU R128 meter, or None."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
             "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
            capture_output=True, text=True, timeout=600,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    matches = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", out.stderr)
    return float(matches[-1]) if matches else None


def _match_loudness(target_path, reference_path):
    """Match `target_path`'s integrated loudness to `reference_path`'s (EBU R128
    via two-pass ffmpeg loudnorm, linear), so the app's original↔clean slider has
    no volume jump (denoising removes energy, leaving the clean otherwise
    quieter). `linear=true` applies a single gain (preserving the denoised
    dynamics) and only falls back to dynamic if it would breach true peak; a high
    target LRA avoids range compression. No-op if measurement fails."""
    ref = _measure_lufs(reference_path)
    if ref is None:
        print("Loudness match skipped (reference measurement failed)")
        return
    # Pass 1: measure the clean's loudnorm stats.
    try:
        p1 = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", target_path,
             "-af", "loudnorm=print_format=json", "-f", "null", "-"],
            capture_output=True, text=True, timeout=600,
        )
    except (OSError, subprocess.SubprocessError):
        return
    m = re.search(r'\{[^{}]*"input_i"[\s\S]*?\}', p1.stderr)
    if not m:
        print("Loudness match skipped (loudnorm measure failed)")
        return
    st = json.loads(m.group(0))
    # Pass 2: normalize to the reference's integrated loudness.
    af = (
        f"loudnorm=I={ref:.2f}:TP=-1.5:LRA=20:linear=true"
        f":measured_I={st['input_i']}:measured_TP={st['input_tp']}"
        f":measured_LRA={st['input_lra']}:measured_thresh={st['input_thresh']}"
        f":offset={st['target_offset']}"
    )
    print(f"Loudness: matching clean to reference {ref:.1f} LUFS (linear)")
    tmp = target_path + ".loudnorm.mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", target_path,
             "-af", af, "-c:a", "libmp3lame", "-b:a", "128k", tmp],
            check=True, capture_output=True, timeout=600,
        )
    except (OSError, subprocess.SubprocessError):
        if os.path.exists(tmp):
            os.unlink(tmp)
        return
    os.replace(tmp, target_path)


def denoise_mp3(
    input_path: str,
    output_path: str = None,
    sample_rate: int = 48000,
    normalize: bool = True,
    noise_profile_path: str = None
):
    """
    Denoise an MP3: produce a single clean file (no original mixed in — the
    app's original↔clean slider is what blends them at playback).

    Processing pipeline:
    1. Load MP3 and convert to mono 48kHz 16-bit PCM
    2. (Optional) Apply spectral subtraction using a noise profile
    3. Denoise using RNNoise frame-by-frame
    4. Export as MP3 (128kbps — matches the canonical original)
    5. Loudness-match the clean to the original's integrated loudness (EBU R128)
       so the app slider has no volume jump

    Args:
        input_path: Path to input MP3 file
        output_path: Path to output MP3 file (if None, adds "_denoised" suffix)
        sample_rate: Processing sample rate (default: 48000 Hz, RNNoise native rate)
        normalize: Loudness-match the clean to the original (default: True)
        noise_profile_path: Path to noise profile WAV file (optional)
    """
    input_path = Path(input_path)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    if output_path is None:
        output_path = input_path.parent / f"{input_path.stem}_denoised{input_path.suffix}"
    else:
        output_path = Path(output_path)

    print(f"Processing started: {input_path}")

    audio = AudioSegment.from_mp3(str(input_path))

    # Ensure mono audio (RNNoise requirement)
    if audio.channels > 1:
        audio = audio.set_channels(1)

    # Resample to target rate if needed
    if audio.frame_rate != sample_rate:
        audio = audio.set_frame_rate(sample_rate)

    # Ensure 16-bit PCM format
    audio = audio.set_sample_width(2)

    # Create temporary WAV files for processing
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_input, \
         tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_output:

        temp_input_path = temp_input.name
        temp_output_path = temp_output.name

    try:
        # Prepare audio data
        audio_array = np.array(audio.get_array_of_samples(), dtype=np.int16)
        audio_float = audio_array.astype(np.float32) / 32768.0
        sf.write(temp_input_path, audio_float, sample_rate, subtype='PCM_16')
        audio_data, _ = sf.read(temp_input_path, dtype='int16')
        if len(audio_data.shape) > 1:
            audio_data = audio_data[:, 0]

        # Step 1: Apply spectral subtraction if noise profile provided
        processed_audio = audio_data
        if noise_profile_path and Path(noise_profile_path).exists():
            print("Applying spectral subtraction with noise profile...")
            noise_profile = load_noise_profile(noise_profile_path, sample_rate)

            # Convert to float for spectral subtraction
            audio_float_for_spectral = audio_data.astype(np.float32) / 32768.0
            cleaned_audio_float = spectral_subtraction(
                audio_float_for_spectral,
                noise_profile,
                sample_rate=sample_rate,
                noise_factor=1.5,
                floor_factor=0.002
            )
            # Convert back to int16 for RNNoise
            processed_audio = (cleaned_audio_float * 32768.0).astype(np.int16)

        # Step 2: Denoise with RNNoise.
        print("Denoising with RNNoise...")
        denoiser = RNNoise(sample_rate=sample_rate)
        denoised_frames = []
        for _speech_prob, denoised_frame in denoiser.denoise_chunk(processed_audio, partial=True):
            denoised_frames.append(denoised_frame)

        if not denoised_frames:
            raise ValueError("No audio frames were denoised")
        denoised_audio_data = np.concatenate([frame.flatten() for frame in denoised_frames])

        # Export to MP3 (128k — matches the canonical original).
        sf.write(temp_output_path, denoised_audio_data, sample_rate, subtype='PCM_16')
        denoised_audio = AudioSegment.from_wav(temp_output_path)
        denoised_audio.export(str(output_path), format="mp3", bitrate="128k")

        # Loudness-match the clean to the original (so the app slider has no
        # volume jump). Denoising removes energy → clean is otherwise quieter.
        if normalize:
            _match_loudness(str(output_path), str(input_path))

        print(f"Completed: {output_path}")

    finally:
        # Clean up temporary files
        if os.path.exists(temp_input_path):
            os.unlink(temp_input_path)
        if os.path.exists(temp_output_path):
            os.unlink(temp_output_path)


def process_single_file(args):
    """
    Wrapper function to process a single file (for parallel processing).

    Args:
        args: Tuple of (input_file, output_file, sample_rate, normalize, noise_profile_path)

    Returns:
        Tuple of (input_file, success, error_message)
    """
    input_file, output_file, sample_rate, normalize, noise_profile_path = args

    try:
        denoise_mp3(
            str(input_file),
            str(output_file),
            sample_rate=sample_rate,
            normalize=normalize,
            noise_profile_path=noise_profile_path
        )
        return (input_file, True, None)
    except Exception as e:
        return (input_file, False, str(e))


def find_and_process_files(
    root_dir: str = ".",
    sample_rate: int = 48000,
    normalize: bool = True,
    workers: int = 1,
    noise_profile_path: str = None
):
    """
    Recursively find all 'original.mp3' files and process them to 'clean.mp3'.

    Args:
        root_dir: Root directory to start searching (default: current directory)
        sample_rate: Processing sample rate (default: 48000 Hz)
        normalize: Loudness-match the clean to the original (default: True)
        workers: Number of parallel workers (default: 1, sequential processing)
        noise_profile_path: Path to noise profile WAV file (optional)
    """
    root_path = Path(root_dir).resolve()

    # Find all original.mp3 files recursively and sort them
    original_files = sorted(root_path.rglob("original.mp3"))

    total = len(original_files)

    # Prepare arguments for each file
    tasks = [
        (input_file, input_file.parent / "clean.mp3", sample_rate, normalize, noise_profile_path)
        for input_file in original_files
    ]

    with tqdm(total=total, desc="Overall Progress", unit="file", ncols=100) as pbar:
        if workers == 1:
            # Sequential processing
            for task in tasks:
                input_file = task[0]
                relative_path = input_file.relative_to(root_path) if input_file.is_relative_to(root_path) else input_file
                pbar.set_postfix_str(f"{relative_path}")

                process_single_file(task)
                pbar.update(1)
        else:
            # Parallel processing
            with ProcessPoolExecutor(max_workers=workers) as executor:
                futures = {executor.submit(process_single_file, task): task for task in tasks}

                for future in as_completed(futures):
                    input_file, success, error = future.result()
                    relative_path = input_file.relative_to(root_path) if input_file.is_relative_to(root_path) else input_file
                    pbar.set_postfix_str(f"{relative_path}")
                    pbar.update(1)


def main():
    parser = argparse.ArgumentParser(
        description="Recursively find 'original.mp3' files and denoise them to 'clean.mp3'",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3.10 denoise_mp3.py
  python3.10 denoise_mp3.py --root-dir /path/to/files
  python3.10 denoise_mp3.py --sample-rate 48000
  python3.10 denoise_mp3.py -n noise-profile.wav  # Use noise profile
  python3.10 denoise_mp3.py --no-normalize  # Skip loudness match to original
  python3.10 denoise_mp3.py --workers 4  # Process 4 files in parallel
  python3.10 denoise_mp3.py -i in.mp3 -o clean.mp3  # Single-file mode
        """
    )

    parser.add_argument(
        "--root-dir",
        help="Root directory to search for original.mp3 files (default: current directory)",
        default="."
    )

    parser.add_argument(
        "-i", "--in",
        dest="in_path",
        help="Single-file mode: path to one input audio file. Requires --out. "
             "Bypasses the recursive original.mp3 search.",
        type=str,
        default=None
    )

    parser.add_argument(
        "-o", "--out",
        dest="out_path",
        help="Single-file mode: destination path for the denoised file. Requires --in.",
        type=str,
        default=None
    )

    parser.add_argument(
        "-s", "--sample-rate",
        help="Sample rate for processing (default: 48000 Hz)",
        type=int,
        default=48000
    )

    parser.add_argument(
        "--no-normalize",
        help="Disable loudness-matching the clean to the original",
        action="store_true",
        default=False
    )

    parser.add_argument(
        "-w", "--workers",
        help="Number of parallel workers for processing files (default: 1, sequential)",
        type=int,
        default=1
    )

    parser.add_argument(
        "-n", "--noise-profile",
        help="Path to noise profile WAV file (e.g., noise-profile.wav)",
        type=str,
        default=None
    )

    args = parser.parse_args()

    # Single-file mode: --in and --out must be supplied together.
    if args.in_path or args.out_path:
        if not (args.in_path and args.out_path):
            parser.error("--in and --out must be used together")
        denoise_mp3(
            args.in_path,
            args.out_path,
            sample_rate=args.sample_rate,
            normalize=not args.no_normalize,
            noise_profile_path=args.noise_profile,
        )
        return

    find_and_process_files(
        root_dir=args.root_dir,
        sample_rate=args.sample_rate,
        normalize=not args.no_normalize,
        workers=args.workers,
        noise_profile_path=args.noise_profile
    )


if __name__ == "__main__":
    main()
