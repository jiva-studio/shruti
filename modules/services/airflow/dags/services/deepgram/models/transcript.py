from typing import TypedDict


class TranscriptBlock(TypedDict):
    type: str
    start: float | None = None
    end: float | None = None
    text: str | None = None


class Transcript(TypedDict):
    language: str
    blocks: list[TranscriptBlock]
    version: int = 1
