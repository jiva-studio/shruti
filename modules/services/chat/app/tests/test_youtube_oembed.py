"""`YouTubeOEmbed.describe`: card metadata for a pasted YouTube link, None for
anything it cannot describe. No network: every request goes to a mock transport."""

from __future__ import annotations

from typing import Any, Callable

import httpx
import pytest

from shruti_chat.lecture_search.models import Candidate
from shruti_chat.lecture_search.providers import youtube_oembed
from shruti_chat.lecture_search.providers.youtube_oembed import YouTubeOEmbed

_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch):
    requests: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def _install(handler: Callable[[httpx.Request], httpx.Response]) -> list[httpx.Request]:
        def _record(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return handler(request)

        def _client(**kwargs: Any) -> httpx.AsyncClient:
            return real_client(transport=httpx.MockTransport(_record), **kwargs)

        monkeypatch.setattr(youtube_oembed.httpx, "AsyncClient", _client)
        return requests

    return _install


async def test_a_youtube_link_is_described(serve) -> None:
    requests = serve(lambda _r: httpx.Response(200, json={
        "title": "Lecture", "author_name": "Speaker", "thumbnail_url": "https://i/x.jpg",
    }))

    got = await YouTubeOEmbed().describe(_URL)

    assert got == Candidate(
        url=_URL, title="Lecture", author="Speaker", thumbnail="https://i/x.jpg",
        provider="user_link",
    )
    assert requests[0].url.params["url"] == _URL
    assert requests[0].url.params["format"] == "json"


async def test_a_non_youtube_link_makes_no_request(serve) -> None:
    requests = serve(lambda _r: httpx.Response(200, json={}))

    assert await YouTubeOEmbed().describe("https://vimeo.com/123") is None
    assert requests == []


@pytest.mark.parametrize("respond", [
    lambda _r: httpx.Response(404),
    lambda _r: httpx.Response(200, content=b"not json"),
    lambda _r: httpx.Response(200, json=["not", "an", "object"]),
    lambda _r: httpx.Response(200, json="text"),
    lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=r)),
])
async def test_a_failed_lookup_describes_nothing(serve, respond) -> None:
    serve(respond)

    assert await YouTubeOEmbed().describe(_URL) is None


async def test_missing_fields_become_empty_strings(serve) -> None:
    serve(lambda _r: httpx.Response(200, json={"title": None}))

    got = await YouTubeOEmbed().describe(_URL)

    assert got is not None
    assert (got.title, got.author, got.thumbnail) == ("", "", "")


async def test_the_timeout_reaches_the_client(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    real_client = httpx.AsyncClient

    def _client(**kwargs: Any) -> httpx.AsyncClient:
        seen.update(kwargs)
        return real_client(
            transport=httpx.MockTransport(lambda _r: httpx.Response(404)), **kwargs,
        )

    monkeypatch.setattr(youtube_oembed.httpx, "AsyncClient", _client)

    await YouTubeOEmbed(timeout_s=0.5).describe(_URL)

    assert seen["timeout"] == 0.5
