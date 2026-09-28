import asyncio
import json

import httpx
import pytest

from share_transcript.bunny import BunnyStorage, new_client


def storage(handler) -> tuple[BunnyStorage, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    store = BunnyStorage(
        zone="zone",
        endpoint="https://storage.example.test/",
        client=new_client("secret", httpx.MockTransport(record)),
    )
    return store, seen


@pytest.mark.parametrize(("status", "want"), [(200, True), (206, True), (404, False)])
def test_exists_probes_one_byte(status, want):
    store, seen = storage(lambda _r: httpx.Response(status))
    assert asyncio.run(store.exists("public/tracks/t/exports/ru.pdf")) is want
    req = seen[0]
    assert req.method == "GET"
    assert str(req.url) == "https://storage.example.test/zone/public/tracks/t/exports/ru.pdf"
    assert req.headers["AccessKey"] == "secret"
    assert req.headers["Range"] == "bytes=0-0"


def test_exists_raises_on_an_unexpected_status():
    store, _ = storage(lambda _r: httpx.Response(401))
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(store.exists("k"))


def test_get_json_reads_the_object():
    body = {"segments": [{"text": "hello"}]}
    store, seen = storage(lambda _r: httpx.Response(200, content=json.dumps(body).encode()))
    assert asyncio.run(store.get_json("public/tracks/t/transcripts/ru.json")) == body
    assert str(seen[0].url) == "https://storage.example.test/zone/public/tracks/t/transcripts/ru.json"
    assert seen[0].headers["AccessKey"] == "secret"


def test_get_text_of_a_missing_object_is_none():
    store, _ = storage(lambda _r: httpx.Response(404))
    assert asyncio.run(store.get_text("k")) is None


def test_get_text_raises_on_an_unexpected_status():
    store, _ = storage(lambda _r: httpx.Response(500))
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(store.get_text("k"))


def test_put_uploads_the_bytes():
    store, seen = storage(lambda _r: httpx.Response(201))
    asyncio.run(store.put("public/tracks/t/exports/ru.pdf", b"%PDF", "application/pdf"))
    req = seen[0]
    assert req.method == "PUT"
    assert str(req.url) == "https://storage.example.test/zone/public/tracks/t/exports/ru.pdf"
    assert req.headers["AccessKey"] == "secret"
    assert req.headers["Content-Type"] == "application/pdf"
    assert req.content == b"%PDF"


@pytest.mark.parametrize(
    "key",
    ["public/../private/x", "../../../x", "public/./x", "public//x", "/public/x", "", "public/x/.."],
)
def test_a_key_that_leaves_its_path_is_never_requested(key):
    store, seen = storage(lambda _r: httpx.Response(200))
    with pytest.raises(ValueError):
        asyncio.run(store.exists(key))
    with pytest.raises(ValueError):
        asyncio.run(store.put(key, b"x", "text/plain"))
    assert seen == []


def test_reserved_characters_stay_inside_their_segment():
    store, seen = storage(lambda _r: httpx.Response(404))
    asyncio.run(store.exists("public/a#b?c%2e/x y.json"))
    url = seen[0].url
    assert url.raw_path == b"/zone/public/a%23b%3Fc%252e/x%20y.json"
    assert url.query == b""


def test_put_raises_when_the_store_refuses():
    store, _ = storage(lambda _r: httpx.Response(401))
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(store.put("k", b"x", "text/plain"))
