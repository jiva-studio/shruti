from re import findall as re_findall
from airflow.decorators import task


@task(
  task_display_name="🔀 Enrich Chunk")
def transcript_enrich_chunk(
  chunks: tuple[str, str],
):
  original, procerssed = chunks
  pattern       = r"\{(\d+)\}\s?([^{}]*)?"
  original_sentences  = re_findall(pattern, original)
  procerssed_sentences = re_findall(pattern, procerssed)

  # Check if the profread chunk is valid:
  # - Length of the original and proofread chunks should be the same
  # - The sentence numbers in the original and proofread chunks should be the same
  if len(original_sentences) == len(procerssed_sentences):
    sentence_numbers_original = [int(sentence[0]) for sentence in procerssed_sentences]
    sentence_numbers_proofread = [int(sentence[0]) for sentence in procerssed_sentences]
    if sentence_numbers_original == sentence_numbers_proofread:
      return procerssed

  print("Original Chunk:\n", original)
  print("Processed Chunk:\n", procerssed)
  raise ValueError("Processed chunk is invalid")
