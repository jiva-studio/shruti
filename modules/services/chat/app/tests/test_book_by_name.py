"""A book is named, not chosen from a list.

The router's prompt carried nine book codes. The catalog holds nineteen
sources, so «Шикшаштака 1 найди лекции» — a real request, from a real person on
2026-08-05 — was answered out of the Nārada-bhakti-sūtra: the nearest item on a
list that could not contain what was asked for. Everything added to the library
after that list was written was equally unaskable: the letters, the Ramayana,
the three parts of Caitanya-caritāmṛta as separate books.

So the model repeats the name as the person said it and the catalog decides
what it means. Measured against the real dictionary:

    «Гита» 1.0 · «Бхагаватам» 1.0 · «Книга Кришны» 0.85 · «Мадхья-лила» 1.0
    «письма Прабхупады» 1.0 · «Рамаяна» 1.0 · «БГ» 1.0 · "SB" 1.0
    «Шикшаштака» 0.42 → below the bar, so no filter at all

That last line is the point: a name the catalog does not know must not become a
filter, and must not be silently forgotten either — it is set aside under
`unknown_source`, which no filter reads and the lead-in does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

import lectorium_chat
from lectorium_chat.agent.graph.nodes import router as router_mod
from lectorium_chat.agent.graph.nodes.router import router_node
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.routing import RoutingDecision


_GITA = "source_dsicuBsFvinZ"


@dataclass
class _Hit:
    id: str
    confidence: float


class _Catalog:
    """The catalog's own fuzzy lookup, trimmed to the names these tests use."""

    _BOOKS = {
        "гита": _Hit(_GITA, 1.0),
        "бг": _Hit(_GITA, 1.0),
        "bg": _Hit(_GITA, 1.0),
        "письма прабхупады": _Hit("source_29BBziLVQh2Y", 1.0),
        # Śikṣāṣṭaka is not a book in this corpus; the closest row the scorer
        # finds is Īśopaniṣad at 0.42, which the confidence bar rejects.
        "шикшаштака": _Hit("source_mA0FlWmbt5K0", 0.42),
    }

    def __init__(self) -> None:
        self.asked: list[str] = []

    async def resolve(self, kind: str, text: str, *, lang=None, limit: int = 1):
        self.asked.append(f"{kind}:{text}")
        hit = self._BOOKS.get(text.strip().lower())
        return [hit] if hit else []


@dataclass
class _Ctx:
    llm: Any | None = None
    request_id: str = "req"
    kv_cache: Any | None = None
    embed_task: Any | None = None
    langfuse_trace_id: str | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    lang_code: str = "ru"
    lang_name: str = ""
    catalog_repo: Any | None = None
    author_scope: Any | None = None
    chunk_repo: Any | None = None
    user_id: str = ""


@dataclass
class _Runtime:
    context: _Ctx


@pytest.fixture(autouse=True)
def _plain_router(monkeypatch: pytest.MonkeyPatch):
    """Silence everything the router does apart from settling the book."""
    async def _no_classifier(*_a, **_k):
        return None

    async def _identity(_history, query, **_k):
        return query

    monkeypatch.setattr(router_mod, "run_classifier_chain", _no_classifier)
    monkeypatch.setattr(router_mod, "resolve_followup_query", _identity)
    monkeypatch.setattr(router_mod, "get_stream_writer", lambda: (lambda _e: None))


async def _settle(monkeypatch: pytest.MonkeyPatch, args: dict) -> dict:
    async def _decision(*_a, **_k):
        return RoutingDecision(intent="find_track", confidence=1.0, extracted_args=args)

    monkeypatch.setattr(router_mod, "run_router_turn", _decision)
    catalog = _Catalog()
    out = await router_node(
        {"user_query": "q", "lang": "ru", "history": []},
        _Runtime(_Ctx(catalog_repo=catalog)),
    )
    return out["extracted_args"]


# ── naming a book ─────────────────────────────────────────────────────────


async def test_a_book_named_in_words_becomes_the_catalog_id(monkeypatch) -> None:
    got = await _settle(monkeypatch, {"source": "Гита"})
    assert got["source_id"] == _GITA
    assert "source" not in got, "the raw name must not travel on as a filter"


async def test_a_book_the_prompts_old_list_never_had(monkeypatch) -> None:
    # The letters were unaskable for as long as the list existed.
    got = await _settle(monkeypatch, {"source": "письма Прабхупады"})
    assert got["source_id"] == "source_29BBziLVQh2Y"


@pytest.mark.parametrize("code", ["БГ", "BG"])
async def test_the_short_codes_the_model_used_to_emit_still_work(
    monkeypatch, code: str,
) -> None:
    """No flag day: a decision made under the old prompt — or served from the
    cache for the next seven days — resolves exactly as before."""
    got = await _settle(monkeypatch, {"source_id": code})
    assert got["source_id"] == _GITA


# ── naming a book we do not have ──────────────────────────────────────────


async def test_a_book_we_do_not_have_never_becomes_a_filter(monkeypatch) -> None:
    got = await _settle(monkeypatch, {"source": "Шикшаштака", "tokens": "1"})
    assert "source_id" not in got, "0.42 is a guess, and a guess here is a wrong book"
    assert got["unknown_source"] == "Шикшаштака"
    assert got["tokens"] == "1"


async def test_the_name_survives_so_the_answer_can_admit_it(monkeypatch) -> None:
    got = await _settle(monkeypatch, {"source_id": "Шикшаштака"})
    assert got["unknown_source"] == "Шикшаштака"


async def test_naming_no_book_leaves_the_args_alone(monkeypatch) -> None:
    got = await _settle(monkeypatch, {"topic": "карма"})
    assert got == {"topic": "карма"}


# ── what the rest of the turn does with it ────────────────────────────────


def test_an_unknown_book_is_not_a_catalog_anchor() -> None:
    """`source_id` sends a «сделай pdf лекции по …» turn to the catalog worker,
    which looks the book up. There is nothing to look up here, so the turn goes
    the semantic way instead — a behaviour change worth pinning."""
    from lectorium_chat.agent.graph.conditional import route_after_router

    known = {"intent": "create_action",
             "extracted_args": {"action_kind": "pdf", "source_id": _GITA}}
    unknown = {"intent": "create_action",
               "extracted_args": {"action_kind": "pdf", "unknown_source": "Шикшаштака"}}
    assert route_after_router(known) == "catalog_worker"
    assert route_after_router(unknown) == "research_worker"


async def test_the_lead_in_is_told_the_book_is_missing(monkeypatch) -> None:
    """Searching the rest of the corpus is fine; implying we looked inside a
    book we do not have is not."""
    from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw

    seen: dict[str, str] = {}

    class _LLM:
        async def text_completion(self, msgs, **_kw):
            seen["user"] = msgs[-1]["content"]
            return "line"

    ctx = _Ctx(llm=_LLM())
    await ftw._intro(ctx, "Шикшаштака 1 найди лекции", 3, "", unknown_source="Шикшаштака")
    assert "Шикшаштака" in seen["user"]
    assert "no such book" in seen["user"]


async def test_a_normal_turn_says_nothing_about_missing_books(monkeypatch) -> None:
    from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw

    seen: dict[str, str] = {}

    class _LLM:
        async def text_completion(self, msgs, **_kw):
            seen["user"] = msgs[-1]["content"]
            return "line"

    await ftw._intro(_Ctx(llm=_LLM()), "лекции про карму", 3, "")
    assert "no such book" not in seen["user"]


# ── the list itself ───────────────────────────────────────────────────────


def test_the_prompt_no_longer_carries_a_list_of_books() -> None:
    """The guard that keeps this from growing back. Not "the list is current" —
    lists rot — but "there is no list": the catalog is the only place that knows
    what books exist."""
    md = (
        Path(lectorium_chat.__file__).resolve().parent
        / "agent" / "prompts" / "router.md"
    ).read_text(encoding="utf-8")
    assert "BG | SB" not in md
    assert "source_id" not in md, "the router names a book, it does not pick an id"


async def test_the_lead_in_admits_the_book_had_no_lectures() -> None:
    """«найди лекции по письмам Прабхупады» came back as «вот лекции по письмам
    Прабхупады, но не из всех источников» — over lectures with nothing to do
    with the letters. The book resolved, the search found nothing on it, the
    filter was given up, and the line went on speaking as though it held."""
    from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw

    seen: dict[str, str] = {}

    class _LLM:
        async def text_completion(self, msgs, **_kw):
            seen["user"] = msgs[-1]["content"]
            return "line"

    await ftw._intro(
        _Ctx(llm=_LLM()), "найди лекции по письмам Прабхупады", 5, "source",
        dropped_source="Письма",
    )
    assert "NO lectures on Письма" in seen["user"]
    assert "do NOT describe" in seen["user"]


async def test_a_kept_book_says_nothing_of_the_sort() -> None:
    from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw

    seen: dict[str, str] = {}

    class _LLM:
        async def text_completion(self, msgs, **_kw):
            seen["user"] = msgs[-1]["content"]
            return "line"

    await ftw._intro(_Ctx(llm=_LLM()), "лекции по Гите", 5, "")
    assert "NO lectures on" not in seen["user"]
