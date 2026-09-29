"""The storage keys a request may name, and the ones the service derives.

Every value a caller sends that ends up in a key is matched whole against a
closed shape before it is used, so no request can reach outside
`public/tracks/<id>/`.
"""

from __future__ import annotations

import re

_ID = r"[A-Za-z0-9_-]{1,128}"
_LANG = r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}"

_TRACK_ID = re.compile(_ID)
_LANG_CODE = re.compile(_LANG)
_TRANSCRIPT_KEY = re.compile(rf"public/tracks/(?P<id>{_ID})/transcripts/{_LANG}\.json")


def is_track_id(value: str) -> bool:
    return _TRACK_ID.fullmatch(value) is not None


def is_lang(value: str) -> bool:
    return len(value) <= 16 and _LANG_CODE.fullmatch(value) is not None


def is_transcript_key(value: str, track_id: str) -> bool:
    """True for a transcript key of exactly the track `track_id`."""
    match = _TRANSCRIPT_KEY.fullmatch(value)
    return match is not None and match["id"] == track_id


def pdf_key(track_id: str, lang: str) -> str:
    if not (is_track_id(track_id) and is_lang(lang)):
        raise ValueError("track_id or lang outside the allowed shape")
    return f"public/tracks/{track_id}/exports/{lang}.pdf"
