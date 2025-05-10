from typing import TypedDict


class TrackLanguage(TypedDict):
  language: str
  source: str # track | transcript
  type: str # original | generated

class TrackTranscript(TypedDict):
  path: str

class TrackAudio(TypedDict):
  path: str
  file_size: int
  duration: int

class Track(TypedDict):
  _id: str
  type: str
  version: int
  location: str | None
  date: list[int] | None
  author: str
  title: dict[str, str]
  references: list[list[str|int]]
  audio: dict[str, TrackAudio]
  transcripts: dict[str, TrackTranscript]
  languages: list[TrackLanguage]
  tags: list[str] | None
