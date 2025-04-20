from re import findall as re_findall
from airflow.decorators import task
import jellyfish

@task(
  task_display_name="🔀 Enrich Chunk")
def transcript_enrich_chunk(
  chunks: tuple[str, str],
):
  original, proofread = chunks
  pattern             = r"\{(\d+)\}\s?([^{}]*)?"
  original_sentences  = re_findall(pattern, original)
  proofread_sentences = re_findall(pattern, proofread)
  
  print("Original: ", original_sentences)
  print("Proofread: ", proofread_sentences)

  # If the sentences are already in the same order, return the proofread text
  # no need to do any matching or sorting here
  sentence_numbers_original  = [int(sentence[0]) for sentence in original_sentences]
  sentence_numbers_proofread = [int(sentence[0]) for sentence in proofread_sentences]
  if sentence_numbers_original == sentence_numbers_proofread:
    return proofread

  # Otherwise, we need to match the sentences in the original and proofread text
  # based on their similarity and return the proofread text with the original sentence numbers
  # in the same order as the original text
  result = []
  for original_sentence_idx, original_sentence in original_sentences:
    best_match_id = -1
    best_match_score = 0

    context_to_search_in = proofread_sentences[int(original_sentence_idx)-5:int(original_sentence_idx)+5]
    for proofread_sentence_idx, proofread_sentence in context_to_search_in:
      distance = jellyfish.jaro_winkler_similarity(original_sentence, proofread_sentence)
      if distance > best_match_score:
        best_match_score = distance
        best_match_id = int(proofread_sentence_idx)

    if best_match_id != -1:
      print(original_sentence, proofread_sentences[best_match_id][1], best_match_score)
      result.append((original_sentence_idx, proofread_sentences[best_match_id][1]))
    else:
      print(original_sentence, "No match")
      result.append((original_sentence_idx, ""))

  return " ".join([ f"{{{s[0]}}} {s[1]}" for s in result ])

