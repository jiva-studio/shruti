from uuid import uuid4
from airflow.decorators import task
from pydub import AudioSegment


@task(
  task_display_name="🤐 Audio: Isolate Segments",
  multiple_outputs=False)
def audio_isolate_segments(
  file: str,
  segments: list[list[tuple[int, int]]],
) -> dict:
  audio_original = AudioSegment.from_mp3(file)
  audio_output = AudioSegment.silent(duration=len(audio_original))
  segments_flat = [item for sublist in segments for item in sublist]

  for start, end in segments_flat:
    print(f"Isolating audio form {start} to {end}")
    audio_output = audio_output.overlay(
      audio_original[start*1000:end*1000], position=start*1000)

  tmp_path = "/tmp/" + str(uuid4())
  audio_output.export(tmp_path, format="mp3")
  return tmp_path

