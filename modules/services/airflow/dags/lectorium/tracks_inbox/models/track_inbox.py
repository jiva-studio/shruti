from typing import Generic, TypedDict, TypeVar

T = TypeVar('T')


class NormalizedValue(TypedDict, Generic[T]):
    original: str
    normalized: T | None

class TrackInbox(TypedDict):
    # Unique identifier
    _id: str

    # Path to the source file
    source: str

    # Title of the track
    title: NormalizedValue[str]

    # Author of the track
    author: NormalizedValue[str]

    # List of references
    references: list[NormalizedValue[list[str]]]

    # Location
    location: NormalizedValue[str]

    # Date
    date: NormalizedValue[list[int]]

    # File size in bytes
    file_size: int

    # Duration of the track in seconds
    duration: int

    # Extract transcript from audio for languages
    extract_languages: list[str]

    # List of languages to translate transcript into
    translate_into: list[str]

    # Status of the track
    status: str # new, ready, processing, done, error

    # Tasks status
    tasks: dict[str, str] | None
