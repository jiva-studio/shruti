from airflow.decorators import task
from lectorium.transcripts.models.transcript import Transcript


@task(
  task_display_name="✂️ Split Transcript Into Chunks")
def transcript_split_into_chunks(
  transcript: Transcript,
  chunk_size: int,
) -> str:
  blocks = transcript["blocks"]
  return [
    " ".join([
      f"{{{sentence_idx}}} {block.get('text', '')}"
      for sentence_idx, block in enumerate(blocks[chunk_idx:chunk_idx + chunk_size])
    ])
    for chunk_idx in range(0, len(blocks), chunk_size)
  ]
