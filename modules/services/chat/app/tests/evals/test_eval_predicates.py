"""Unit tests for the eval predicate machinery.

Live eval (run_chunk_tools_eval.py:run_eval) is too expensive to run
from CI, but its predicate logic is pure and worth testing — the JSONL
case file is only useful if the predicate engine correctly distinguishes
pass from fail.
"""

from __future__ import annotations

from tests.evals.run_chunk_tools_eval import (
    args_subset_match,
    predicate_match,
)


def test_args_subset_match_passes_on_extras() -> None:
    assert args_subset_match({"type": "verse", "top_k": 8}, {"type": "verse"})


def test_args_subset_match_fails_on_mismatch() -> None:
    assert not args_subset_match({"type": "lecture"}, {"type": "verse"})


def test_args_subset_match_empty_expected_passes() -> None:
    assert args_subset_match({"anything": "x"}, {})
    assert args_subset_match({}, None)


def test_predicate_min_count() -> None:
    result = [{"type": "verse"}, {"type": "verse"}]
    ok, _ = predicate_match(result, {"min_count": 2})
    assert ok
    ok, reason = predicate_match(result, {"min_count": 5})
    assert not ok and "min_count" in reason


def test_predicate_all_items_filter() -> None:
    result = [{"type": "verse"}, {"type": "lecture"}]
    ok, _ = predicate_match(result, {"all_items": [{"type": "verse"}]})
    assert not ok  # second item violates filter
    result2 = [{"type": "verse"}, {"type": "verse"}]
    ok, _ = predicate_match(result2, {"all_items": [{"type": "verse"}]})
    assert ok


def test_predicate_label_contains() -> None:
    result = [{"label": "БГ 2.13"}]
    ok, _ = predicate_match(result, {"all_items": [{"label_contains": "2.13"}]})
    assert ok
    ok, _ = predicate_match(result, {"all_items": [{"label_contains": "5.5.3"}]})
    assert not ok


def test_predicate_no_item() -> None:
    result = [{"type": "lecture", "meta": {"track_id": "real"}}]
    # Forbidden meta.track_id present → fail.
    ok, _ = predicate_match(result, {"no_item": {"meta.track_id": "real"}})
    assert not ok
    # Different track_id → pass.
    ok, _ = predicate_match(result, {"no_item": {"meta.track_id": "other"}})
    assert ok


def test_predicate_diversity() -> None:
    result = [{"type": "lecture"}, {"type": "verse"}, {"type": "lecture"}]
    ok, _ = predicate_match(
        result,
        {"diversity": {"type": ["lecture", "verse"], "min_each": 1}},
    )
    assert ok
    # Need 2 verses, only 1 present → fail.
    ok, reason = predicate_match(
        result,
        {"diversity": {"type": ["lecture", "verse"], "min_each": 2}},
    )
    assert not ok and "diversity" in reason


def test_predicate_score_min() -> None:
    result = [{"score": 0.9}, {"score": 0.5}]
    ok, _ = predicate_match(result, {"score_min": 0.4})
    assert ok
    ok, reason = predicate_match(result, {"score_min": 0.6})
    assert not ok and "score" in reason


def test_predicate_not_a_list_fails() -> None:
    error_result = {"error": "user_context_missing"}
    ok, reason = predicate_match(error_result, {"min_count": 1})
    assert not ok and "list" in reason
