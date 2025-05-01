from uuid import uuid4
from airflow.decorators import task
from pydub import AudioSegment


@task(
  task_display_name="🪡 Audio: Create From Segments",
  multiple_outputs=False)
def audio_create_from_segments(
  file: str,
  segments: list[list[tuple[int, int]]],
  max_duration: int = 60,
) -> str:
  audio = AudioSegment.from_mp3(file)
  result_audio = AudioSegment.empty()
  total_length = 0
  segments_flat = [item for sublist in segments for item in sublist]
  for start, end in segments_flat:

    # NOTE: skip first 10 minutes of audio, because there may be a kirtan
    # TODO: automatically find end of kirtan
    if start <= 600:
      continue
    
    print(f"Getting audio form {start} to {end}")
    result_audio += audio[start*1000:end*1000]
    total_length += end - start
    if total_length >= max_duration:
      break

  tmp_path = "/tmp/lectorium/" + str(uuid4())
  with open(tmp_path, "wb") as f:
    result_audio.export(f, format="mp3")
  return tmp_path
