import re
import os
from pathlib import Path
from typing import List, Tuple
from elevenlabs.client import ElevenLabs
from elevenlabs import save
from pydub import AudioSegment

# ---------- config ----------
API_KEY = ""
VOICE_ID = "gedzfqL7OGdPbwm0ynTP"
MODEL_ID = "eleven_multilingual_v2"
OUTPUT_DIR = Path("./output/audio_segments")
TRANSCRIPT_PATH = Path("./output/translated.txt")
FINAL_MP3 = Path("./output/final_output.mp3")

# ---------- setup ----------
client = ElevenLabs(api_key=API_KEY)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------- parsing ----------
TIMESTAMP_RE = re.compile(r"\((\d+(?:\.\d+)?)\)")

def parse_transcript_seconds_format(text: str) -> List[Tuple[int, str]]:
    """
    Input format example (seconds with fractions, inline):
      (0.0) ...судевая. (2.414) Ом намо ... (8.247) ...
    Returns sorted list of (start_ms, text) for each span between timestamps.
    """
    segments: List[Tuple[int, str]] = []
    matches = list(TIMESTAMP_RE.finditer(text))
    for i, m in enumerate(matches):
        start_s = float(m.group(1))
        start_ms = int(round(start_s * 1000))
        seg_start = m.end()
        seg_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        seg_text = text[seg_start:seg_end].strip()

        # collapse internal whitespace a bit, but keep punctuation/brackets intact
        seg_text = re.sub(r"[ \t]+", " ", seg_text)
        seg_text = re.sub(r"\n\s*\n+", "\n\n", seg_text).strip()

        if seg_text:
            segments.append((start_ms, seg_text))
    # Ensure chronological order
    segments.sort(key=lambda x: x[0])
    return segments

# ---------- TTS ----------
def generate_segment_audio(
    text: str,
    output_file: Path,
    voice_id: str = VOICE_ID,
    previous_text: str = "",
    next_text: str = "",
):
    audio = client.text_to_speech.convert(
        text=text,
        next_text=next_text,
        previous_text=previous_text,
        voice_id=voice_id,
        model_id=MODEL_ID,
        output_format="mp3_44100_128",
    )
    save(audio, str(output_file))

# ---------- combine ----------
def combine_segments(segments: List[Tuple[int, str, Path]], output_file: Path):
    """
    segments: list of (start_ms, text, mp3_path)
    Places each segment at its absolute start time; pads silence as needed.
    """
    combined = AudioSegment.silent(duration=0)
    current_ms = 0

    for start_ms, _text, mp3_path in segments:
        seg_audio = AudioSegment.from_mp3(mp3_path)
        silence = max(0, start_ms - current_ms)
        if silence:
            combined += AudioSegment.silent(duration=silence)
            current_ms += silence
        combined += seg_audio
        current_ms += len(seg_audio)

    combined.export(str(output_file), format="mp3")

# ---------- main ----------
def main():
    # 1) read transcript
    raw = TRANSCRIPT_PATH.read_text(encoding="utf-8")

    # 2) parse to (start_ms, text)
    parsed = parse_transcript_seconds_format(raw)
    if not parsed:
        raise ValueError("No segments parsed. Check transcript timestamp format like (12.345).")

    parsed = list(filter(lambda t: t[0] < 100*1000, parsed))

    # 3) generate audio files (with prev/next context)
    rendered: List[Tuple[int, str, Path]] = []
    total = len(parsed)
    for idx, (start_ms, text) in enumerate(parsed):
        out_file = OUTPUT_DIR / f"segment_{idx:04d}.mp3"

        prev_text = parsed[idx - 1][1] if idx > 0 else ""
        next_text = parsed[idx + 1][1] if idx + 1 < total else ""

        if out_file.exists():
            rendered.append((start_ms, text, out_file))
            continue

        print(f"[{idx+1}/{len(parsed)}] {start_ms/1000:.3f}s → TTS, {len(text)} chars")
        generate_segment_audio(
            text,
            out_file,
            voice_id=VOICE_ID,
            previous_text=prev_text,
            next_text=next_text,
        )
        rendered.append((start_ms, text, out_file))

    # 4) combine on absolute timeline
    combine_segments(rendered, FINAL_MP3)
    print(f"Done. Wrote {FINAL_MP3}")

if __name__ == "__main__":
    main()
