from airflow.decorators import task

from shruti.transcripts.models.transcript import TranscriptChunk


@task(
    task_display_name="📜 Transcript Chunk to Plain Text")
def transcript_chunk_to_plain_text(
    transcript_chunk: TranscriptChunk,
) -> str:

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    chunk_plain_text = " ".join(
        [
            f"{{{transcript_chunk['chunk_index']}:{idx}}} {block.get('text', '')}"
            for idx, block in enumerate(transcript_chunk["blocks"])
        ]
    )

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    return chunk_plain_text
