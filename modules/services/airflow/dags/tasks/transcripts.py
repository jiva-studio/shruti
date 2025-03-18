from re import findall as re_findall

from airflow.decorators import task

from lectorium.transcripts import Transcript


@task(task_display_name="✂️ Split Transcript Into Chunks")
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


@task(task_display_name="🔀 Enrich Chunk")
def transcript_enrich_chunk(
    chunks: tuple[str, str],
):
    original, procerssed = chunks
    pattern              = r"\{(\d+)\}\s?([^{}]*)?"
    original_sentences   = re_findall(pattern, original)
    procerssed_sentences = re_findall(pattern, procerssed)

    # Check if the profread chunk is valid:
    # - Length of the original and proofread chunks should be the same
    # - The sentence numbers in the original and proofread chunks should be the same
    if len(original_sentences) == len(procerssed_sentences):
        sentence_numbers_original  = [int(sentence[0]) for sentence in procerssed_sentences]
        sentence_numbers_proofread = [int(sentence[0]) for sentence in procerssed_sentences]
        if sentence_numbers_original == sentence_numbers_proofread:
            return procerssed

    print("Original Chunk:\n", original)
    print("Processed Chunk:\n", procerssed)
    raise ValueError("Processed chunk is invalid")


@task(task_display_name="🔀 Enrich Transcript")
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
    processed_sentences_count  = len(processed_sentences)
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
