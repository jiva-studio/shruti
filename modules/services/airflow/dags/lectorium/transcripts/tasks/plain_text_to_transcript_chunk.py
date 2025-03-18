from re import findall
from airflow.decorators import task

from lectorium.transcripts.models.transcript import TranscriptChunk, TranscriptBlock


@task(task_display_name="📜 Plain Text to Transcript Chunk")
def plain_text_to_transcript_chunk(
    text: str,
) -> TranscriptChunk:
    transcript_chunk = TranscriptChunk(
        blocks=[],
    )

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    pattern = r"\{(\d+):(\d+)\}\s([^{}]+)?"
    matches = findall(pattern, text + "\n")

    for chunk_index, sentence_index, sentence in matches:
        transcript_chunk["chunk_index"] = int(chunk_index)

        if sentence.strip() == "":
            transcript_chunk["blocks"].append(TranscriptBlock(type="paragraph"))
        else:
            transcript_chunk["blocks"].append(
                TranscriptBlock(type="sentence", text=sentence.strip())
            )

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    return transcript_chunk
