from airflow.decorators import task

from lectorium.transcripts.models.transcript import Transcript, TranscriptChunk


@task(task_display_name="🪡 Merge Transcript Chunks")
def merge_transcript_chunks(
    transcript_chunks: list[TranscriptChunk],
) -> Transcript:
    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    # sort the transcript chunks by chunk index
    ordered_transcript_chunks = sorted(
        transcript_chunks,
        key=lambda chunk: chunk["chunk_index"]
    )

    # merge the transcript chunks into a single transcript
    transcript = Transcript(
        blocks=[
            block
            for chunk in ordered_transcript_chunks
            for block in chunk["blocks"]
        ]
    )

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    return transcript
