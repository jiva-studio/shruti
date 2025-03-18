import jellyfish
from collections import namedtuple

from airflow.decorators import task

from lectorium.transcripts.models.transcript import TranscriptChunk


@task(task_display_name="🌟 Enrich Transcript Chunk")
def enrich_transcript_chunk(
    transcript_chunks: tuple[TranscriptChunk, TranscriptChunk],
    find_nearest_sentence: bool = False,
) -> str:
    original_chunk, edited_chunk = transcript_chunks

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    IndexedSentence = namedtuple("IndexedSentence", ["index", "text"])



    for original_idx, original_block in enumerate(original_chunk["blocks"]):
        if original_block["type"] == "paragraph":
            continue

        if find_nearest_sentence:
            # list of tuples (index, distance, distance in text)
            distances: list[tuple[int, int, int]] = []

            sentences_original: list[IndexedSentence] = [
                IndexedSentence(idx, block.get("text", ""))
                for idx, block in enumerate(edited_chunk["blocks"])
            ]

            distances = [
                (
                    idx,
                    jellyfish.damerau_levenshtein_distance(original_block["text"], s.text),
                    abs(idx - original_idx)
                )
                for idx, s in enumerate(sentences_original)
            ]

            # sort by distance and then by index.
            # so we should find similar sentences with the closest index
            distances = filter(lambda x: x[2] <= 3, distances)
            distances = sorted(distances, key=lambda x: (x[1], x[2]))

            if distances:
                closest_original = sentences_original[distances[0][0]]
                original_block["text"] = edited_chunk["blocks"][closest_original.index].get("text", "")
        else:
            if original_idx >= len(edited_chunk["blocks"]):
                continue # some shit happened
            original_block["text"] = edited_chunk["blocks"][original_idx].get("text", "")

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    return original_chunk
