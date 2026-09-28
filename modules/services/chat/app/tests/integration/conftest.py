"""Fixtures for the tests that talk to real infrastructure.

The gate itself (`--integration` / `SHRUTI_INTEGRATION_DB`) lives in the root
`tests/conftest.py`, because it is driven by the `needs_db` / `needs_network`
markers declared there and those can be worn by a test in any directory. A
test here is gated by what it needs, not by its directory.
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
