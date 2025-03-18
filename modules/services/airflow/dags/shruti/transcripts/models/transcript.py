from typing import TypedDict


class TranscriptBlock(TypedDict):
    type: str
    start: float | None = None
    end: float | None = None
    text: str | None = None


class Transcript(TypedDict):
    blocks: list[TranscriptBlock]


class TranscriptChunk(TypedDict):
    chunk_index: int
    blocks: list[TranscriptBlock]
