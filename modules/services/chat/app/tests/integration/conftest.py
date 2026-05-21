"""Gate integration tests behind --integration / SHRUTI_INTEGRATION_DB.

Without those, pytest collects but SKIPs every test here so `pytest tests/`
stays fast in CI without Postgres."""

from __future__ import annotations

import os

import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--integration",
        action="store_true",
        default=False,
        help="Run integration tests (requires Postgres + OpenRouter API key).",
    )


def pytest_collection_modifyitems(config, items):
    if config.getoption("--integration"):
        return
    if os.environ.get("SHRUTI_INTEGRATION_DB"):
        return
    skip = pytest.mark.skip(reason="integration tests require --integration or SHRUTI_INTEGRATION_DB")
    # Only skip items in THIS conftest's directory tree (the integration/
    # sub-suite). Without this guard, conftest at tests/integration/ would
    # bubble up and skip every other test too.
    integration_root = os.path.dirname(__file__)
    for item in items:
        if str(item.fspath).startswith(integration_root):
            item.add_marker(skip)


@pytest.fixture(scope="session")
def integration_db_url() -> str:
    url = os.environ.get("SHRUTI_INTEGRATION_DB")
    if not url:
        pytest.skip("SHRUTI_INTEGRATION_DB not set")
    return url
