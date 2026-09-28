import asyncio
import json
from typing import Any

import pytest

from share_transcript import pipeline
from share_transcript.meta import TrackMeta

PDF = "public/tracks/t1/exports/ru.pdf"
MARKER = PDF + ".version"
TRANSCRIPT = "public/tracks/t1/transcripts/ru.json"


class MemoryStore:
    def __init__(self, objects: dict[str, bytes] | None = None) -> None:
        self.objects = dict(objects or {})
        self.writes: list[str] = []

    async def exists(self, key: str) -> bool:
        return key in self.objects

    async def get_text(self, key: str) -> str | None:
        body = self.objects.get(key)
        return None if body is None else body.decode()

    async def get_json(self, key: str) -> dict[str, Any]:
        return json.loads(self.objects[key])

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = data
        self.writes.append(key)


def public_url(key: str) -> str:
    return "https://cdn.example.test/" + key


def prepare(store: MemoryStore) -> dict[str, Any]:
    async def run() -> dict[str, Any]:
        result = await pipeline.prepare_pdf(
            meta=TrackMeta(id="t1", title="Lecture"),
            lang="ru",
            transcript_key=TRANSCRIPT,
            store=store,
            public_url=public_url,
        )
        await asyncio.gather(*pipeline._inflight.values())
        return result

    return asyncio.run(run())


@pytest.fixture
def rendered(monkeypatch):
    monkeypatch.setattr(pipeline, "render_transcript_pdf", lambda **_kw: b"%PDF-new")


def test_a_pdf_with_the_current_version_marker_is_served(rendered):
    store = MemoryStore({PDF: b"%PDF-old", MARKER: pipeline.PDF_RENDER_VERSION.encode()})
    result = prepare(store)
    assert result == {"track_id": "t1", "lang": "ru", "url": public_url(PDF), "ready": True}
    assert store.writes == []


@pytest.mark.parametrize("marker", [None, b"v0"])
def test_a_pdf_without_the_current_marker_is_rendered_again(rendered, marker):
    objects = {PDF: b"%PDF-old", TRANSCRIPT: b'{"segments": []}'}
    if marker is not None:
        objects[MARKER] = marker
    store = MemoryStore(objects)
    result = prepare(store)
    assert result["ready"] is False
    assert result["url"] == public_url(PDF)
    assert store.objects[PDF] == b"%PDF-new"
    assert store.objects[MARKER] == pipeline.PDF_RENDER_VERSION.encode()
    assert store.writes == [PDF, MARKER]


class FlakyMarkerStore(MemoryStore):
    """Refuses the first `failures` writes of the version marker."""

    def __init__(self, objects: dict[str, bytes], failures: int) -> None:
        super().__init__(objects)
        self.failures = failures

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        if key == MARKER and self.failures > 0:
            self.failures -= 1
            raise RuntimeError("storage refused the write")
        await super().put(key, data, content_type)


def test_a_lost_marker_write_is_retried_without_rendering_again(monkeypatch):
    renders = []
    monkeypatch.setattr(
        pipeline, "render_transcript_pdf", lambda **_kw: renders.append(1) or b"%PDF-new"
    )
    store = FlakyMarkerStore({TRANSCRIPT: b'{"segments": []}'}, failures=2)

    first = prepare(store)
    assert first["ready"] is False
    assert store.objects[PDF] == b"%PDF-new"
    assert MARKER not in store.objects

    second = prepare(store)
    assert second["ready"] is False
    assert MARKER not in store.objects

    third = prepare(store)
    assert third["ready"] is True
    assert store.objects[MARKER] == pipeline.PDF_RENDER_VERSION.encode()
    assert len(renders) == 1


def test_an_unsafe_track_id_never_becomes_a_key(rendered):
    store = MemoryStore({TRANSCRIPT: b"{}"})

    async def run() -> None:
        await pipeline.prepare_pdf(
            meta=TrackMeta(id="../leak"),
            lang="ru",
            transcript_key=TRANSCRIPT,
            store=store,
            public_url=public_url,
        )

    with pytest.raises(ValueError):
        asyncio.run(run())
    assert store.writes == []


def test_a_missing_transcript_is_reported_before_rendering(rendered):
    store = MemoryStore()
    with pytest.raises(pipeline.TranscriptUnavailable):
        prepare(store)
    assert store.writes == []
