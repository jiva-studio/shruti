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


# ── Multi-agent predicates via evaluate_case ─────────────────────────────


from tests.evals.observation import TurnObservation, ToolInvocation
from tests.evals.run_chunk_tools_eval import evaluate_case


def _obs(
    *,
    intent: str | None = None,
    tool_chain: list[tuple[str, dict, object]] | None = None,
    response_text: str = "",
) -> TurnObservation:
    """Small builder for clarity in test cases."""
    chain = [
        ToolInvocation(name=n, args=a, result=r)
        for n, a, r in (tool_chain or [])
    ]
    return TurnObservation(intent=intent, tool_chain=chain, response_text=response_text)


# expect_intent

def test_expect_intent_match() -> None:
    ok, _ = evaluate_case({"expect_intent": "research"}, _obs(intent="research"))
    assert ok


def test_expect_intent_mismatch() -> None:
    ok, fails = evaluate_case({"expect_intent": "research"}, _obs(intent="direct_chat"))
    assert not ok and any("intent" in f for f in fails)


def test_expect_intent_none_obs() -> None:
    """Router never ran (legacy monolith) → expect_intent fails."""
    ok, fails = evaluate_case({"expect_intent": "research"}, _obs(intent=None))
    assert not ok and any("intent" in f for f in fails)


# expect_no_tool

def test_expect_no_tool_pass_when_empty_chain() -> None:
    ok, _ = evaluate_case({"expect_no_tool": True}, _obs(intent="direct_chat"))
    assert ok


def test_expect_no_tool_fail_when_tool_called() -> None:
    ok, fails = evaluate_case(
        {"expect_no_tool": True},
        _obs(tool_chain=[("search_x", {}, [])]),
    )
    assert not ok and any("expect_no_tool" in f for f in fails)


# expect_tool_chain (subsequence)

def test_expect_tool_chain_exact_order_passes() -> None:
    obs = _obs(tool_chain=[("a", {}, []), ("b", {}, []), ("c", {}, [])])
    ok, _ = evaluate_case({"expect_tool_chain": ["a", "b", "c"]}, obs)
    assert ok


def test_expect_tool_chain_with_extras_in_between_passes() -> None:
    """LLM may call extra helper tools; subsequence still satisfied."""
    obs = _obs(
        tool_chain=[("a", {}, []), ("helper", {}, []), ("b", {}, []), ("c", {}, [])]
    )
    ok, _ = evaluate_case({"expect_tool_chain": ["a", "b", "c"]}, obs)
    assert ok


def test_expect_tool_chain_wrong_order_fails() -> None:
    obs = _obs(tool_chain=[("b", {}, []), ("a", {}, [])])
    ok, fails = evaluate_case({"expect_tool_chain": ["a", "b"]}, obs)
    assert not ok and any("tool_chain" in f for f in fails)


def test_expect_tool_chain_missing_tool_fails() -> None:
    obs = _obs(tool_chain=[("a", {}, [])])
    ok, fails = evaluate_case({"expect_tool_chain": ["a", "b"]}, obs)
    assert not ok and "missing 'b'" in fails[0]


# expect_no_marker_kind

def test_expect_no_marker_kind_pass_when_absent() -> None:
    obs = _obs(response_text="Plain text without markers.")
    ok, _ = evaluate_case({"expect_no_marker_kind": "cite"}, obs)
    assert ok


def test_expect_no_marker_kind_fail_when_present() -> None:
    obs = _obs(
        response_text="In [cite:track_X@100-200|caption] he says..."
    )
    ok, fails = evaluate_case({"expect_no_marker_kind": "cite"}, obs)
    assert not ok and any("expect_no_marker_kind" in f for f in fails)


def test_expect_no_marker_kind_unrelated_marker_doesnt_trip() -> None:
    """`expect_no_marker_kind=cite` shouldn't flag a `[verse:...]`."""
    obs = _obs(response_text="See [verse:source_BG/2.13|БГ 2.13] for context.")
    ok, _ = evaluate_case({"expect_no_marker_kind": "cite"}, obs)
    assert ok


# expect_response_contains (case-insensitive substring AND)

def test_expect_response_contains_all_present() -> None:
    obs = _obs(response_text="Не нашёл подходящих материалов.")
    ok, _ = evaluate_case({"expect_response_contains": ["не нашёл"]}, obs)
    assert ok


def test_expect_response_contains_case_insensitive() -> None:
    obs = _obs(response_text="COULD NOT FIND any matching verses.")
    ok, _ = evaluate_case({"expect_response_contains": ["could not find"]}, obs)
    assert ok


def test_expect_response_contains_missing_one_fails() -> None:
    obs = _obs(response_text="Found two matches.")
    ok, fails = evaluate_case(
        {"expect_response_contains": ["found", "matches", "no-such-thing"]}, obs
    )
    assert not ok and any("no-such-thing" in f for f in fails)


# expect_response_contains_marker

def test_expect_response_contains_marker_blockquote() -> None:
    obs = _obs(response_text="> Цитата из комментария\n>\n> — БГ 2.13")
    ok, _ = evaluate_case({"expect_response_contains_marker": "blockquote"}, obs)
    assert ok


def test_expect_response_contains_marker_blockquote_missing() -> None:
    obs = _obs(response_text="Plain text without blockquote.")
    ok, fails = evaluate_case({"expect_response_contains_marker": "blockquote"}, obs)
    assert not ok and any("blockquote" in f for f in fails)


def test_expect_response_contains_marker_verse_present() -> None:
    obs = _obs(response_text="See [verse:source_BG/2.13|БГ 2.13]")
    ok, _ = evaluate_case({"expect_response_contains_marker": "verse"}, obs)
    assert ok


# Combined predicate cases (realistic eval cases)

def test_combined_direct_chat_case() -> None:
    """A direct_chat case: intent matches, no tools called."""
    case = {"expect_intent": "direct_chat", "expect_no_tool": True}
    obs = _obs(intent="direct_chat", tool_chain=[], response_text="Привет!")
    ok, fails = evaluate_case(case, obs)
    assert ok, fails


def test_combined_commentary_case() -> None:
    """commentary lookup: tool called, response is blockquote, NO cite marker."""
    case = {
        "expect_intent": "research",
        "expect_tool": "chunks_get_by_address",
        "expect_args": {"type": "commentary"},
        "expect_no_marker_kind": "cite",
        "expect_response_contains_marker": "blockquote",
    }
    obs = _obs(
        intent="research",
        tool_chain=[
            (
                "chunks_get_by_address",
                {"type": "commentary", "book": "BG", "tokens": "2.47"},
                [{"type": "commentary", "text": "..."}],
            )
        ],
        response_text="> Прабхупада объясняет тонкость кармы...\n>\n> — БГ 2.47, комментарий",
    )
    ok, fails = evaluate_case(case, obs)
    assert ok, fails


def test_combined_multistep_research_case() -> None:
    """Cross-kind chain: tool order matters."""
    case = {
        "expect_intent": "research",
        "expect_tool_chain": ["chunks_search", "chunks_get_by_address"],
    }
    obs = _obs(
        intent="research",
        tool_chain=[
            ("chunks_search", {"query": "karma"}, []),
            ("chunks_get_by_address", {"type": "verse", "book": "BG", "tokens": "4.17"}, []),
        ],
    )
    ok, fails = evaluate_case(case, obs)
    assert ok, fails


def test_case_without_predicates_passes() -> None:
    """A case that declares no expectations always passes — protects
    against zero-predicate cases silently doing nothing harmful."""
    ok, fails = evaluate_case({"query": "x"}, _obs())
    assert ok
    assert fails == []
