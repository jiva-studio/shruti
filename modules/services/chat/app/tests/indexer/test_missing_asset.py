"""A 404 on an advertised transcript is published-data rot, not a fetch error.

`list_transcripts` reads the catalog's `asset_hashes` table as its listing
(Bunny has no anonymous listing), so a row whose object was never uploaded
comes back on every run and fails identically each time — the indexer has
no way to make progress on it. It must be named as such instead of being
logged as an indexing failure with a stack trace.
"""

from __future__ import annotations

import httpx

from lectorium_chat.indexer.run import _is_missing_asset


def _status_error(code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://cdn.example/public/tracks/t/transcripts/en.json")
    response = httpx.Response(code, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


def test_404_is_a_missing_asset() -> None:
    assert _is_missing_asset(_status_error(404))


def test_other_http_errors_stay_failures() -> None:
    for code in (403, 429, 500, 503):
        assert not _is_missing_asset(_status_error(code))


def test_non_http_errors_stay_failures() -> None:
    assert not _is_missing_asset(ValueError("bad transcript json"))
    assert not _is_missing_asset(httpx.ConnectError("connection refused"))
