from fastapi.testclient import TestClient

from share_transcript import main, pipeline
from share_transcript.bunny import BunnyStorage

from .test_pipeline import MARKER, PDF, MemoryStore


def test_the_app_serves_a_current_pdf_from_the_storage_zone(monkeypatch):
    monkeypatch.setenv("STORAGE_ZONE", "test-zone")
    monkeypatch.setenv("STORAGE_KEY", "test-key")
    monkeypatch.setenv("PDFS_PUBLIC_BASE", "https://cdn.example.test")
    with TestClient(main.app) as client:
        assert isinstance(main.app.state.store, BunnyStorage)
        main.app.state.store = MemoryStore(
            {PDF: b"%PDF", MARKER: pipeline.PDF_RENDER_VERSION.encode()}
        )
        resp = client.post(
            "/pdf",
            json={"track_id": "t1", "lang": "ru", "transcript_key": "public/tracks/t1/transcripts/ru.json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "track_id": "t1",
        "lang": "ru",
        "url": "https://cdn.example.test/" + PDF,
        "ready": True,
    }
