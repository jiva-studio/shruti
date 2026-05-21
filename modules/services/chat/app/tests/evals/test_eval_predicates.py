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


def test_expect_response_contains_fails_when_none_match() -> None:
    """ANY-of semantics: predicate fails only when NONE of the needles
    appear in the response. Used for refusal phrasings where any of
    several synonyms is acceptable evidence the model refused — e.g.
    ["could not find", "no results", "couldn't find"]."""
    obs = _obs(response_text="Found two matches.")
    ok, fails = evaluate_case(
        {"expect_response_contains": ["nothing-here", "no-such-thing"]}, obs
    )
    assert not ok and any("nothing-here" in f for f in fails)


def test_expect_response_contains_passes_when_any_match() -> None:
    """Even if some needles are missing, as long as one is present the
    predicate accepts. This is the typical pattern for refusal
    detection — we don't require the model to use a specific wording."""
    obs = _obs(response_text="Found two matches.")
    ok, _ = evaluate_case(
        {"expect_response_contains": ["found", "no-such-thing"]}, obs
    )
    assert ok


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


# ── marker-hygiene predicates ─────────────────────────────────────────


def test_no_duplicate_markers_passes_when_each_cite_unique() -> None:
    case = {"expect_no_duplicate_markers": True}
    obs = _obs(response_text=(
        "Душа вечна. [cite:track_A@0-1000|вечность]\n\n"
        "Душа меняет тела. [cite:track_B@2000-3000|перерождение]\n\n"
        "Душа — частица Бога. [verse:source_BG/15.7|БГ 15.7]"
    ))
    ok, fails = evaluate_case(case, obs)
    assert ok, fails


def test_no_duplicate_markers_fails_on_repeated_cite() -> None:
    """Spammy duplicate cites — same chip rendered 3 times — is
    exactly the regression the LLM was producing on 'что такое разум'
    before we taught it the one-cite-per-thesis structure."""
    case = {"expect_no_duplicate_markers": True}
    obs = _obs(response_text=(
        "Душа вечна. [cite:track_A@0-1000|вечность]\n\n"
        "Душа — это X. [cite:track_A@0-1000|вечность]\n\n"
        "И ещё Y. [cite:track_A@0-1000|вечность]"
    ))
    ok, fails = evaluate_case(case, obs)
    assert not ok
    assert any("cite" in f and "×3" in f for f in fails)


def test_no_duplicate_markers_fails_on_repeated_verse() -> None:
    case = {"expect_no_duplicate_markers": True}
    obs = _obs(response_text=(
        "[verse:source_BG/2.13|БГ 2.13]\n[verse:source_BG/2.13|БГ 2.13]"
    ))
    ok, fails = evaluate_case(case, obs)
    assert not ok
    assert any("verse" in f for f in fails)


def test_no_duplicate_markers_skipped_when_flag_absent() -> None:
    """Cases that don't set the flag aren't checked — opt-in only."""
    obs = _obs(response_text="[cite:A@0-1] [cite:A@0-1]")
    ok, _ = evaluate_case({}, obs)
    assert ok


def test_no_unexpanded_footnote_fails_on_raw_footnote() -> None:
    """Raw [^N] reaching the response = MarkerExpander broken."""
    obs = _obs(response_text="text [^3] tail")
    ok, fails = evaluate_case({}, obs)
    assert not ok
    assert any("[^N]" in f and "[^3]" in f for f in fails)


def test_no_unexpanded_footnote_passes_on_expanded_only() -> None:
    obs = _obs(response_text="text [cite:track_X@0-100] tail")
    ok, fails = evaluate_case({}, obs)
    assert ok, fails


def test_unexpected_bracket_fails_on_arbitrary_shape() -> None:
    """Generic catch: anything bracketed that isn't a whitelisted
    expanded marker (`[cite:...]`, `[verse:...]`, `[card:...]`,
    `[action:...]`, `[followup:...]`) → regression. This catches
    `[ref:1]`, `[note:42]`, `[caption:foo]`, `[ШБ 4.25.26]` etc.
    without enumerating known-bad shapes."""
    obs = _obs(response_text="see [ref:1|caption] here")
    ok, fails = evaluate_case({}, obs)
    assert not ok
    assert any("unexpected" in f for f in fails)


def test_unexpected_bracket_fails_on_invented_marker_kind() -> None:
    """LLM might invent a new marker shape by analogy with the
    documented protocol — `[note:42]`, `[caption:foo]`. Generic
    bracket-check catches it without explicit enumeration."""
    obs = _obs(response_text="text [note:42] tail")
    ok, fails = evaluate_case({}, obs)
    assert not ok


def test_unexpected_bracket_fails_on_raw_shloka_address() -> None:
    """`[ШБ 4.25.26]` would look like a marker to the client but
    isn't one. Catch it."""
    obs = _obs(response_text="как сказано в [ШБ 4.25.26] стихе")
    ok, fails = evaluate_case({}, obs)
    assert not ok


def test_unexpected_bracket_passes_on_expanded_cite() -> None:
    """`[cite:track_X@s-e]` is the whitelisted expanded shape."""
    obs = _obs(response_text="text [cite:track_X@1000-2000|caption] tail")
    ok, fails = evaluate_case({}, obs)
    assert ok, fails


def test_unexpected_bracket_passes_on_expanded_verse_and_card() -> None:
    obs = _obs(response_text=(
        "verse: [verse:source_BG/2.13|БГ 2.13] "
        "card: [card:track_X]"
    ))
    ok, fails = evaluate_case({}, obs)
    assert ok, fails


def test_unexpected_bracket_passes_on_action_and_followup() -> None:
    obs = _obs(response_text=(
        "[action:create_playlist|id=ab12cd34]\n[followup:а что в главе 3?]"
    ))
    ok, fails = evaluate_case({}, obs)
    assert ok, fails


def test_unexpected_bracket_can_be_disabled() -> None:
    """Opt-out flag for cases that intentionally have non-marker
    bracketed text (e.g., testing legacy shape preservation)."""
    obs = _obs(response_text="[ref:1]")
    ok, _ = evaluate_case({"expect_no_unexpected_brackets": False}, obs)
    assert ok
