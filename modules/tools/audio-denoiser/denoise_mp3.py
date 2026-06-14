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
import os
import tempfile
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed

from pydub import AudioSegment
from pyrnnoise import RNNoise
import soundfile as sf
import numpy as np
from scipy.ndimage import gaussian_filter1d
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


def smooth_mix_audio(
    original: np.ndarray,
    processed: np.ndarray,
    voice_probabilities: np.ndarray,
    min_mix_ratio: float,
    max_mix_ratio: float,
    transition_ms: int = 50,
    sample_rate: int = 48000
) -> np.ndarray:
    """
    Mix original and processed audio using RNNoise voice probability detection.

    Uses voice activity detection from RNNoise to dynamically adjust the mix ratio:
    - No voice (0% probability): Uses min_mix_ratio
    - Full voice (100% probability): Uses max_mix_ratio
    - Partial voice: Linear interpolation between min and max
    - Smooth transitions: Gaussian filtering prevents harsh jumps

    Args:
        original: Original audio as int16 numpy array
        processed: Processed (denoised+normalized) audio as int16 numpy array
        voice_probabilities: Voice probability for each frame from RNNoise (0.0-1.0)
        min_mix_ratio: Minimum ratio of original audio when no voice detected (0.0-1.0)
        max_mix_ratio: Maximum ratio of original audio when voice detected (0.0-1.0)
        transition_ms: Transition smoothing time in milliseconds (default: 50ms)
        sample_rate: Audio sample rate (default: 48000 Hz)

    Returns:
        Mixed audio with smooth transitions as int16 numpy array
    """
    original_float = original.astype(np.float32)
    processed_float = processed.astype(np.float32)
    transition_samples = int(transition_ms * sample_rate / 1000)

    # RNNoise processes in 480-sample frames (10ms at 48kHz)
    FRAME_SIZE = 480

    # Create mix envelope based on voice probabilities
    mix_envelope = np.zeros(len(original_float))

    for i, voice_prob in enumerate(voice_probabilities):
        start = i * FRAME_SIZE
        end = min(start + FRAME_SIZE, len(mix_envelope))

        # Interpolate between min and max mix ratio based on voice probability
        # voice_prob = 0.0 (no voice) -> use min_mix_ratio
        # voice_prob = 1.0 (full voice) -> use max_mix_ratio
        current_mix = min_mix_ratio + (max_mix_ratio - min_mix_ratio) * voice_prob

        mix_envelope[start:end] = current_mix

    # Apply Gaussian smoothing for gradual crossfades
    if transition_samples > 0:
        mix_envelope = gaussian_filter1d(mix_envelope, sigma=transition_samples / 3)

    # Final mix: envelope controls blend between original and processed
    mixed = mix_envelope * original_float + (1.0 - mix_envelope) * processed_float

    return mixed.astype(np.int16)


def normalize_audio_evenly(
    audio_data: np.ndarray,
    target_db: float = -20.0,
    threshold_db: float = -40.0
) -> np.ndarray:
    """
    Apply dynamic window-based normalization for consistent volume throughout track.

    Uses overlapping windows to calculate local RMS and apply appropriate gain,
    ensuring even volume without destroying dynamics or amplifying noise.

    Args:
        audio_data: Input audio data as int16 numpy array
        target_db: Target dB level for normalization (default: -20.0 dB, broadcast standard)
        threshold_db: Noise gate threshold in dB (default: -40.0 dB, ignores silence)

    Returns:
        Normalized audio data as int16 numpy array
    """
    audio_float = audio_data.astype(np.float32)

    # Window parameters for smooth normalization
    WINDOW_SIZE = 2048  # ~43ms at 48kHz
    HOP_SIZE = 512      # ~11ms at 48kHz, 75% overlap

    padding = WINDOW_SIZE // 2
    padded_audio = np.pad(audio_float, (padding, padding), mode='reflect')

    # Calculate RMS energy for each window
    rms_values = []
    for i in range(0, len(padded_audio) - WINDOW_SIZE, HOP_SIZE):
        window = padded_audio[i:i + WINDOW_SIZE]
        rms = np.sqrt(np.mean(window ** 2))
        rms_values.append(rms)

    # Convert dB targets to linear scale
    target_rms = 32768.0 * (10 ** (target_db / 20.0))
    threshold_rms = 32768.0 * (10 ** (threshold_db / 20.0))

    # Apply window-based gain
    normalized_audio = np.zeros_like(audio_float)
    counts = np.zeros_like(audio_float)

    for i, rms_val in enumerate(rms_values):
        start_idx = i * HOP_SIZE
        end_idx = start_idx + WINDOW_SIZE

        # Noise gate: skip quiet sections to avoid amplifying silence
        if rms_val < threshold_rms:
            continue

        # Calculate and limit gain
        gain = min(target_rms / rms_val, 10.0) if rms_val > 0 else 1.0  # Max 20dB boost

        # Apply gain to window
        window_slice = slice(max(0, start_idx - padding), min(len(normalized_audio), end_idx - padding))
        audio_slice = slice(max(0, start_idx), min(len(padded_audio), end_idx))

        if window_slice.start < window_slice.stop:
            slice_len = len(normalized_audio[window_slice])
            normalized_audio[window_slice] += padded_audio[audio_slice][:slice_len] * gain
            counts[window_slice] += 1

    # Average overlapping windows
    counts[counts == 0] = 1
    normalized_audio /= counts

    # Final peak limiting to prevent clipping
    peak = np.abs(normalized_audio).max()
    if peak > 32767:
        normalized_audio *= (32767 / peak)

    return normalized_audio.astype(np.int16)


def denoise_mp3(
    input_path: str,
    output_path: str = None,
    sample_rate: int = 48000,
    normalize: bool = True,
    min_mix_ratio: float = 0.0,
    max_mix_ratio: float = 0.0,
    noise_profile_path: str = None
):
    """
    Denoise MP3 file with optional noise profile, RNNoise, normalization, and mixing.

    Processing pipeline:
    1. Load MP3 and convert to mono 48kHz 16-bit PCM
    2. (Optional) Apply spectral subtraction using noise profile
    3. Denoise using RNNoise frame-by-frame (captures voice probabilities)
    4. Normalize volume dynamically across the track
    5. Optionally mix with original audio using voice-probability-based crossfading
    6. Export as MP3 (128kbps — matches the canonical original; the source is
       128k so a higher bitrate would only inflate size without adding quality)

    Args:
        input_path: Path to input MP3 file
        output_path: Path to output MP3 file (if None, adds "_denoised" suffix)
        sample_rate: Processing sample rate (default: 48000 Hz, RNNoise native rate)
        normalize: Apply dynamic normalization (default: True)
        min_mix_ratio: Minimum ratio of original audio when no voice (0.0-1.0)
        max_mix_ratio: Maximum ratio of original audio when voice present (0.0-1.0)
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

        # Step 2: Denoise with RNNoise and capture voice probabilities
        print("Denoising with RNNoise...")
        denoiser = RNNoise(sample_rate=sample_rate)
        denoised_frames = []
        voice_probabilities = []

        for speech_prob, denoised_frame in denoiser.denoise_chunk(processed_audio, partial=True):
            denoised_frames.append(denoised_frame)
            voice_probabilities.append(speech_prob)

        if not denoised_frames:
            raise ValueError("No audio frames were denoised")
        denoised_audio_data = np.concatenate([frame.flatten() for frame in denoised_frames])
        voice_probabilities = np.array(voice_probabilities)

        # Post-processing (Normalize and/or Mix)
        if normalize:
            print("Normalizing...")
            denoised_audio_data = normalize_audio_evenly(
                denoised_audio_data,
                target_db=-5.0,
                threshold_db=-40.0
            )

        # Mix with original using voice probability if min or max mix ratio is set
        if min_mix_ratio > 0.0 or max_mix_ratio > 0.0:
            print(f"Mixing with voice-based crossfading (min: {min_mix_ratio:.0%}, max: {max_mix_ratio:.0%})...")
            min_len = min(len(audio_data), len(denoised_audio_data))
            denoised_audio_data = smooth_mix_audio(
                audio_data[:min_len],
                denoised_audio_data[:min_len],
                voice_probabilities,
                min_mix_ratio,
                max_mix_ratio,
                transition_ms=50,
                sample_rate=sample_rate
            )

        # Export to MP3
        sf.write(temp_output_path, denoised_audio_data, sample_rate, subtype='PCM_16')
        denoised_audio = AudioSegment.from_wav(temp_output_path)
        denoised_audio.export(str(output_path), format="mp3", bitrate="128k")

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
        args: Tuple of (input_file, output_file, sample_rate, normalize, min_mix_ratio, max_mix_ratio, noise_profile_path)

    Returns:
        Tuple of (input_file, success, error_message)
    """
    input_file, output_file, sample_rate, normalize, min_mix_ratio, max_mix_ratio, noise_profile_path = args

    try:
        denoise_mp3(
            str(input_file),
            str(output_file),
            sample_rate=sample_rate,
            normalize=normalize,
            min_mix_ratio=min_mix_ratio,
            max_mix_ratio=max_mix_ratio,
            noise_profile_path=noise_profile_path
        )
        return (input_file, True, None)
    except Exception as e:
        return (input_file, False, str(e))


def find_and_process_files(
    root_dir: str = ".",
    sample_rate: int = 48000,
    normalize: bool = True,
    min_mix_ratio: float = 0.0,
    max_mix_ratio: float = 0.0,
    workers: int = 1,
    noise_profile_path: str = None
):
    """
    Recursively find all 'original.mp3' files and process them to 'clean.mp3'.

    Args:
        root_dir: Root directory to start searching (default: current directory)
        sample_rate: Processing sample rate (default: 48000 Hz)
        normalize: Apply dynamic normalization (default: True)
        min_mix_ratio: Minimum ratio of original audio when no voice (0.0-1.0)
        max_mix_ratio: Maximum ratio of original audio when voice present (0.0-1.0)
        workers: Number of parallel workers (default: 1, sequential processing)
        noise_profile_path: Path to noise profile WAV file (optional)
    """
    root_path = Path(root_dir).resolve()

    # Find all original.mp3 files recursively and sort them
    original_files = sorted(root_path.rglob("original.mp3"))

    total = len(original_files)

    # Prepare arguments for each file
    tasks = [
        (input_file, input_file.parent / "clean.mp3", sample_rate, normalize, min_mix_ratio, max_mix_ratio, noise_profile_path)
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
  python3.10 denoise_mp3.py --mix-min 5 --mix-max 25  # Voice-based mixing (5% no voice, 25% with voice)
  python3.10 denoise_mp3.py --no-normalize  # Skip normalization
  python3.10 denoise_mp3.py --workers 4  # Process 4 files in parallel
  python3.10 denoise_mp3.py -n noise-profile.wav --mix-min 10 --mix-max 20 --workers 4  # Full pipeline
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
        help="Disable even volume normalization throughout the track",
        action="store_true",
        default=False
    )

    parser.add_argument(
        "--mix-min",
        help="Minimum mix percentage of original audio when no voice detected (0-100, default: 0)",
        type=float,
        default=0.0
    )

    parser.add_argument(
        "--mix-max",
        help="Maximum mix percentage of original audio when voice detected (0-100, default: 0)",
        type=float,
        default=0.0
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

    # Convert mix percentages to 0.0-1.0 range
    min_mix = max(0.0, min(100.0, args.mix_min)) / 100.0
    max_mix = max(0.0, min(100.0, args.mix_max)) / 100.0

    # Single-file mode: --in and --out must be supplied together.
    if args.in_path or args.out_path:
        if not (args.in_path and args.out_path):
            parser.error("--in and --out must be used together")
        denoise_mp3(
            args.in_path,
            args.out_path,
            sample_rate=args.sample_rate,
            normalize=not args.no_normalize,
            min_mix_ratio=min_mix,
            max_mix_ratio=max_mix,
            noise_profile_path=args.noise_profile,
        )
        return

    find_and_process_files(
        root_dir=args.root_dir,
        sample_rate=args.sample_rate,
        normalize=not args.no_normalize,
        min_mix_ratio=min_mix,
        max_mix_ratio=max_mix,
        workers=args.workers,
        noise_profile_path=args.noise_profile
    )


if __name__ == "__main__":
    main()
