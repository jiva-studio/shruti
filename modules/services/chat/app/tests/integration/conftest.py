"""Fixtures for the tests that talk to real infrastructure.

The gate itself (`--integration` / `SHRUTI_INTEGRATION_DB`) lives in the root
`tests/conftest.py` now, because it is driven by the `needs_db` / `needs_network`
markers declared there and those can be worn by a test in any directory.

It used to live here and gate on the DIRECTORY: everything under
`tests/integration/` was skipped regardless of what it actually needed.
`test_xff.py` was the cost — seven tests that drive uvicorn's
ProxyHeadersMiddleware entirely in memory, and that guard the spoofing surface
on `X-Forwarded-For`, never ran anywhere. They were skipped for their address.
"""

from __future__ import annotations

import os

import pytest


@pytest.fixture(scope="session")
def integration_db_url() -> str:
    url = os.environ.get("SHRUTI_INTEGRATION_DB")
    if not url:
        pytest.skip("SHRUTI_INTEGRATION_DB not set")
    return url
