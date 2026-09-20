"""The score-config bootstrap must keep matching the Langfuse SDK.

langfuse 3.15 turned `score_configs.create(**fields)` into
`create(*, request: CreateScoreConfigRequest)`. The old call kept raising
`unexpected keyword argument 'name'` for every entry, and because each
failure was a `log.warning` the service booted "fine" with zero configs
registered for months (#1565).

Dependencies float (`langfuse>=3.15,<4`), so the next signature drift has
to break CI instead of production boot. The stub below therefore does not
accept anything the caller passes: it binds every call against the real
`ScoreConfigsClient.create` signature, so a changed signature fails here.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from langfuse.api import CreateScoreConfigRequest
from langfuse.api.resources.score_configs.client import ScoreConfigsClient
from structlog.testing import capture_logs

from shruti_chat.observability.bootstrap import bootstrap_score_configs
from shruti_chat.observability.score_configs import SCORE_CONFIGS


class _SignatureBoundScoreConfigs:
    """Stands in for `langfuse.api.score_configs`, but only accepts calls
    the installed SDK would accept."""

    def __init__(self, existing: list[str] | None = None) -> None:
        self.existing = existing or []
        self.created: list[CreateScoreConfigRequest] = []

    def get(self) -> Any:
        return type(
            "_Page",
            (),
            {"data": [type("_Cfg", (), {"name": n})() for n in self.existing]},
        )()

    def create(self, *args: Any, **kwargs: Any) -> Any:
        bound = inspect.signature(ScoreConfigsClient.create).bind(
            self, *args, **kwargs
        )
        request = bound.arguments["request"]
        assert isinstance(request, CreateScoreConfigRequest)
        self.created.append(request)
        return request


class _StubLangfuse:
    def __init__(self, score_configs: _SignatureBoundScoreConfigs) -> None:
        self.api = type("_Api", (), {"score_configs": score_configs})()


def test_create_is_called_with_a_request_model() -> None:
    configs = _SignatureBoundScoreConfigs()

    bootstrap_score_configs(_StubLangfuse(configs))

    assert len(configs.created) == len(SCORE_CONFIGS)
    assert [r.name for r in configs.created] == [s["name"] for s in SCORE_CONFIGS]


def test_existing_configs_are_skipped() -> None:
    already = SCORE_CONFIGS[0]["name"]
    configs = _SignatureBoundScoreConfigs(existing=[already])

    bootstrap_score_configs(_StubLangfuse(configs))

    assert already not in [r.name for r in configs.created]
    assert len(configs.created) == len(SCORE_CONFIGS) - 1


@pytest.mark.parametrize("spec", SCORE_CONFIGS, ids=lambda s: s["name"])
def test_every_spec_is_a_valid_request(spec: dict) -> None:
    # The model sets `extra="allow"`, so a stale key would be silently
    # forwarded to the API instead of raising — compare keys explicitly.
    assert set(spec) <= set(CreateScoreConfigRequest.__fields__)

    payload = CreateScoreConfigRequest(**spec).dict()

    assert payload["name"] == spec["name"]
    assert payload["dataType"] == spec["data_type"]


def test_a_failing_entry_does_not_stop_the_others() -> None:
    class _OneBadEntry(_SignatureBoundScoreConfigs):
        def create(self, *args: Any, **kwargs: Any) -> Any:
            if len(self.created) == 1:
                self.created.append(None)  # type: ignore[arg-type]
                raise RuntimeError("boom")
            return super().create(*args, **kwargs)

    configs = _OneBadEntry()

    with capture_logs() as logs:
        bootstrap_score_configs(_StubLangfuse(configs))

    assert len(configs.created) == len(SCORE_CONFIGS)

    # The summary has to be loud enough to page someone; #1565 hid behind
    # an `info` line reading `failed: 20` next to per-entry warnings.
    done = next(e for e in logs if e["event"] == "score_configs_bootstrap_done")
    assert done["failed"] == 1
    assert done["log_level"] == "error"


def test_summary_is_info_when_nothing_failed() -> None:
    with capture_logs() as logs:
        bootstrap_score_configs(_StubLangfuse(_SignatureBoundScoreConfigs()))

    done = next(e for e in logs if e["event"] == "score_configs_bootstrap_done")
    assert done["failed"] == 0
    assert done["log_level"] == "info"


def test_missing_langfuse_is_a_no_op() -> None:
    bootstrap_score_configs(None)
