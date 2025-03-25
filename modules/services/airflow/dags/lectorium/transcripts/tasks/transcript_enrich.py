from re import findall as re_findall
from airflow.decorators import task
from lectorium.transcripts import Transcript


@task(
  task_display_name="🔀 Enrich Transcript")
def transcript_enrich(
  transcript: Transcript,
  chunks: list[str],
) -> Transcript:
  pattern = r"\{(\d+)\}\s?([^{}]*)?"
  processed_sentences = [
    match[1].strip() for chunk in chunks for match in re_findall(pattern, chunk)
  ]

  # check if the length of the transcript and the proofread sentences match
  transcript_sentences_count = len(transcript["blocks"])
  processed_sentences_count = len(processed_sentences)
  if transcript_sentences_count != processed_sentences_count:
    raise ValueError(
      "Length of the transcript and the processed sentences do not match: "
      f"{transcript_sentences_count} != {processed_sentences_count}")

  # merge transcript with proofread sentences
  blocks = transcript["blocks"]
  for idx, sentence in enumerate(processed_sentences):
    # check if the block is not a paragraph
    block_is_paragraph = blocks[idx]["type"] == "paragraph"
    if sentence and block_is_paragraph:
      raise ValueError(f"Trying to replace a paragraph with a sentence: {sentence}")
    elif block_is_paragraph:
      continue # do not update the paragraph block

    # update the text of the block
    blocks[idx]["text"] = sentence

  # return the processed transcript
  return transcript