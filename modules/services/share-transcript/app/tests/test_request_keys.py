import pytest
from fastapi.testclient import TestClient

from share_transcript import keys, main

from .test_pipeline import MemoryStore

GOOD = {"track_id": "track_aBC-123", "lang": "ru", "transcript_key": "public/tracks/track_aBC-123/transcripts/ru.json"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("STORAGE_ZONE", "test-zone")
    monkeypatch.setenv("STORAGE_KEY", "test-key")
    monkeypatch.setenv("PDFS_PUBLIC_BASE", "https://cdn.example.test")
    with TestClient(main.app) as c:
        store = MemoryStore()
        main.app.state.store = store
        yield c, store


def post(client, **over):
    c, _ = client
    return c.post("/pdf", json={**GOOD, **over})


@pytest.mark.parametrize(
    "key",
    [
        "public/tracks/../../private/backups/db.json",
        "public/tracks/t/../../../artifacts/tracks/t/meta.json",
        "public/tracks/t/transcripts/../../../x.json",
        "public/tracks/./t/transcripts/ru.json",
        "public/tracks//transcripts/ru.json",
        "public/tracks/t/transcripts/ru.json#frag",
        "public/tracks/t/transcripts/ru.json?x=1",
        "public/tracks/%2e%2e/transcripts/ru.json",
        "public/tracks/t\\..\\x/transcripts/ru.json",
        "public/tracks/t/transcripts/ru.json\n",
        "public/tracks/t\x00/transcripts/ru.json",
        "public/tracks/t/audio/original.mp3",
        "public/tracks/t/transcripts/ru.pdf",
        "private/tracks/t/transcripts/ru.json",
    ],
)
def test_a_transcript_key_off_the_expected_shape_is_refused(client, key):
    resp = post(client, transcript_key=key)
    assert resp.status_code == 400
    assert resp.json()["detail"] == {"code": "bad_transcript_key"}
    assert client[1].writes == []


def test_a_transcript_of_another_track_is_refused(client):
    resp = post(client, transcript_key="public/tracks/other_track/transcripts/ru.json")
    assert resp.status_code == 400
    assert resp.json()["detail"] == {"code": "bad_transcript_key"}
    assert client[1].writes == []


@pytest.mark.parametrize("track_id", ["../leak", "../../../leak", "a/b", "a b", "", "t.", "%2e", "t#", "x" * 129])
def test_an_unsafe_track_id_is_refused(client, track_id):
    resp = post(client, track_id=track_id)
    assert resp.status_code in (400, 422)
    assert client[1].writes == []


@pytest.mark.parametrize(
    "lang", ["../x", "ru/..", "r", "ru.json", "ru?", "ru#", "ru-", "toolonglanguage", "abc-12345678-1234"]
)
def test_an_unsafe_lang_is_refused(client, lang):
    resp = post(client, lang=lang)
    assert resp.status_code in (400, 422)
    assert client[1].writes == []


@pytest.mark.parametrize(
    ("lang", "ok"),
    [("ru", True), ("sr-Latn", True), ("und", True), ("abc-1234567-12345", False), ("abc-12345678-1234", False)],
)
def test_lang_shape(lang, ok):
    assert keys.is_lang(lang) is ok


def test_a_well_formed_request_is_accepted(client):
    resp = post(client)
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"code": "transcript_unavailable"}
