"""A fallback is still an answer — it does not get to forget who was asked for.

Three lanes are reached only AFTER the main, correctly-scoped search came back
empty, and all three used to search as if no one had chosen anything:

- the out-of-corpus memory pass re-searched the WHOLE corpus (the one fanout
  call in the codebase with neither the author scope nor the private library),
  so «отвечай только по лекциям X» came back citing somebody else under a
  disclaimer saying the corpus had nothing — and the honest «у выбранных
  лекторов ничего нет» line was suppressed, because a lecture note was now
  present;
- the bare-reference probe and the date probe queried the catalog with
  `author_id=None`, dropping not only a standing choice but the teacher the
  question itself named.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.application.author_scope import AuthorScope
from shruti_chat.domain.author_selection import AuthorSelection
from shruti_chat.domain.conversation_attributes import LECTURE_AUTHORS, Attribute


_PRABHU = "author_prabhupada"


def _scope(*, constrained: bool = True) -> AuthorScope:
    scope = AuthorScope(catalog_repo=None, user_id="u-1", request_id="req")
    scope.apply(
        AuthorSelection.from_attributes({
            LECTURE_AUTHORS: Attribute(value=[_PRABHU], explicit=True),
        })
        if constrained else AuthorSelection.unconstrained()
    )
    return scope


# ── the memory pass ───────────────────────────────────────────────────────


@dataclass
class _FallbackCtx:
    llm: Any
    request_id: str = "req"
    langfuse_trace_id: str = ""
    embedder: Any | None = None
    chunk_repo: Any | None = None
    catalog_repo: Any | None = None
    aliases: Any | None = None
    reranker: Any | None = None
    retrieval_lang_code: str | None = None
    author_scope: Any | None = None
    user_id: str = ""


@dataclass
class _Runtime:
    context: Any


class _MemoryLLM:
    async def structured_output(self, messages, schema, **_kw):
        return schema(
            in_scope=True, confidence="high", disclaimer="d",
            answer="a", search_queries=["карма"],
        )


class _OwnedRepo:
    """Stands in for the chunk repo: knows which tracks this person added."""

    def __init__(self, owned: list[str]) -> None:
        self._owned = owned

    async def get_owned_track_ids(self, user_id: str) -> list[str]:
        return list(self._owned)

    async def distinct_langs(self) -> list[str]:
        return ["ru"]


async def _run_fallback(monkeypatch: pytest.MonkeyPatch, ctx: Any) -> dict:
    from shruti_chat.agent.graph.nodes import corpus_fallback as mod

    seen: dict[str, Any] = {}

    async def _fake_fanout(_queries, **kw):
        seen.update(kw)
        from shruti_chat.research.models import FanoutResult

        return FanoutResult()

    monkeypatch.setattr(mod, "fanout_search_with_boost", _fake_fanout)
    monkeypatch.setattr(mod, "get_stream_writer", lambda: (lambda _e: None))

    async def _lang(*_a, **_k):
        return "ru"

    monkeypatch.setattr(mod, "resolve_retrieval_lang", _lang)

    async def _noop(*_a, **_k):
        return None

    monkeypatch.setattr(mod, "flush_card_payloads", _noop)
    monkeypatch.setattr(mod, "translate_commentaries", _noop)
    await mod.corpus_fallback_node({"user_query": "карма", "lang": "ru"}, _Runtime(ctx))
    return seen


async def test_the_memory_pass_honours_the_chosen_lecturers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scope = _scope()
    ctx = _FallbackCtx(
        llm=_MemoryLLM(), embedder=object(), chunk_repo=_OwnedRepo([]),
        catalog_repo=object(), author_scope=scope,
    )
    seen = await _run_fallback(monkeypatch, ctx)
    assert seen["author_scope"] is scope


async def test_the_memory_pass_can_see_the_personal_library(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Announcing "the corpus has nothing" while the person's own recording of
    # exactly this sits indexed is the worst version of this turn.
    ctx = _FallbackCtx(
        llm=_MemoryLLM(), embedder=object(), chunk_repo=_OwnedRepo(["mine"]),
        catalog_repo=object(), author_scope=_scope(), user_id="u-1",
    )
    seen = await _run_fallback(monkeypatch, ctx)
    assert seen["owned_track_ids"] == ["mine"]


async def test_an_anonymous_turn_asks_for_no_private_tracks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ctx = _FallbackCtx(
        llm=_MemoryLLM(), embedder=object(), chunk_repo=_OwnedRepo(["mine"]),
        catalog_repo=object(), user_id="",
    )
    seen = await _run_fallback(monkeypatch, ctx)
    assert seen["owned_track_ids"] is None


# ── the catalog probes ────────────────────────────────────────────────────


@dataclass
class _Track:
    id: str
    lang: str = "ru"


class _ProbeCatalog:
    """Records the filters each probe asked for, and answers with two tracks by
    two different teachers."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def list_tracks(self, **kw):
        self.calls.append(kw)
        if kw.get("author_id"):
            return [_Track("his")]
        return [_Track("his"), _Track("hers")]

    async def resolve(self, kind, text, *, lang=None, limit=1):
        return []

    async def source_short_label(self, source_id, *, lang):
        return "ШБ" if str(source_id).startswith("source_") else None


@dataclass
class _ProbeCtx:
    catalog_repo: Any
    author_scope: Any | None = None
    lang_code: str = "ru"
    request_id: str = "req"
    llm: Any | None = None
    capabilities: dict = field(default_factory=dict)


async def _probe_ref(ctx: Any, monkeypatch: pytest.MonkeyPatch) -> list[str]:
    from shruti_chat.agent.graph.nodes import find_tracks_worker as mod

    served: list[str] = []

    async def _renderable(_ctx, tracks):
        served.extend(t.id for t in tracks)
        return []

    monkeypatch.setattr(mod, "_renderable", _renderable)

    async def _reply(*_a, **_k):
        return type("R", (), {"line": "", "chips": []})()

    monkeypatch.setattr(mod, "localized_reply", _reply)
    await mod._probe_and_answer_ref(
        ctx, lambda _e: None, "source_SB", "2.9.1", author_id="author_prabhupada",
    )
    return served


async def test_the_reference_probe_keeps_the_named_teacher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = _ProbeCatalog()
    await _probe_ref(_ProbeCtx(catalog_repo=catalog), monkeypatch)
    assert catalog.calls[0]["author_id"] == "author_prabhupada"


async def test_the_reference_probe_drops_what_the_selection_excludes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _OnlyHis:
        async def narrow(self, ids):
            return [i for i in ids if i == "his"]

    catalog = _ProbeCatalog()

    async def _no_author(**kw):
        catalog.calls.append(kw)
        return [_Track("his"), _Track("hers")]

    catalog.list_tracks = _no_author  # the ref index knows nothing about authors
    served = await _probe_ref(
        _ProbeCtx(catalog_repo=catalog, author_scope=_OnlyHis()), monkeypatch,
    )
    assert served == ["his"]


async def test_the_date_probe_keeps_the_named_teacher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from shruti_chat.agent.graph.nodes import find_tracks_worker as mod

    catalog = _ProbeCatalog()

    async def _renderable(_ctx, _tracks):
        return []

    monkeypatch.setattr(mod, "_renderable", _renderable)

    async def _reply(*_a, **_k):
        return type("R", (), {"line": "", "chips": []})()

    monkeypatch.setattr(mod, "localized_reply", _reply)
    await mod._probe_and_answer_date(
        _ProbeCtx(catalog_repo=catalog), lambda _e: None,
        None, None, "07-09", author_id="author_prabhupada",
    )
    assert catalog.calls[0]["author_id"] == "author_prabhupada"


async def test_an_unconstrained_turn_leaves_the_probe_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog = _ProbeCatalog()
    served = await _probe_ref(
        _ProbeCtx(catalog_repo=catalog, author_scope=_scope(constrained=False)),
        monkeypatch,
    )
    assert served == ["his"]
