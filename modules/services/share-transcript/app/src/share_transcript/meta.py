"""TrackMeta — the cover/header metadata the renderer reads.

The caller (chat, which has the catalog; or the mobile app, from its local
content DB) assembles these fields and sends them on the wire. share-transcript
never looks track metadata up itself — it only renders. The attribute
names mirror the chat `Track` entity exactly so `render_transcript_pdf`
works unchanged after the move.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _s(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v or None


@dataclass(frozen=True, slots=True)
class RefMeta:
    short_name: str | None = None
    full_name: str | None = None
    source_id: str | None = None
    tokens: str | None = None


@dataclass(frozen=True, slots=True)
class TrackMeta:
    id: str
    title: str | None = None
    author_name: str | None = None
    author_id: str | None = None
    date: str | None = None
    location_name: str | None = None
    location_id: str | None = None
    references: list[RefMeta] = field(default_factory=list)
    tag_names: list[str] = field(default_factory=list)

    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> "TrackMeta":
        refs = [
            RefMeta(
                short_name=_s(r.get("short_name")),
                full_name=_s(r.get("full_name")),
                source_id=_s(r.get("source_id")),
                tokens=_s(r.get("tokens")),
            )
            for r in (d.get("references") or [])
            if isinstance(r, dict)
        ]
        tags = [t for t in (d.get("tags") or []) if isinstance(t, str)]
        return cls(
            id=str(d.get("track_id") or ""),
            title=_s(d.get("title")),
            author_name=_s(d.get("author_name")),
            author_id=_s(d.get("author_id")),
            date=_s(d.get("date")),
            location_name=_s(d.get("location_name")),
            location_id=_s(d.get("location_id")),
            references=refs,
            tag_names=tags,
        )
