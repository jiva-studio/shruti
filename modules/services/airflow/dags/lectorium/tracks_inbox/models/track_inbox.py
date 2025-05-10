from typing import Generic, TypedDict, TypeVar

T = TypeVar('T')


class NormalizedValue(TypedDict, Generic[T]):
    extracted: str
    normalized: T | None

class TrackInbox(TypedDict):
    # Unique identifier
    _id: str

    # Track ID
    track_id: str

    # Path to the source file
    path: str

    # Title of the track
    title: NormalizedValue[str]

    # Author of the track
    author: NormalizedValue[str]

    # List of references
    references: NormalizedValue[list[str|int]]

    # Location
    location: NormalizedValue[str]

    # Date
    date: NormalizedValue[list[int]]

    # File size in bytes
    file_size: int

    # Duration of the track in seconds
    duration: int

    # Extract transcript from audio for languages
    languagesExtract: list[str]

    # List of languages to translate transcript into
    languagesTranslateInto: list[str]

    # Status of the track
    status: str # new, verification, pending, processing, done, error

    # Tasks status
    tasks: dict[str, str] | None

    # Tags
    tags: list[str] | None
