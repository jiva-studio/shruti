"""Read conversation attributes off a message, and recall what was already known.

Two halves.

**Detection.** One cheap structured call per attribute in the registry, all
fired concurrently and all overlapping the router's own LLM call, so N
attributes cost one round-trip of wall-clock. Per-attribute rather than one
combined call on purpose: a schema miss on one attribute does not lose the
others, and each attribute's prompt is tuned (and hosted in Langfuse) on its
own. If the registry ever grows past a handful, batch them then — the wire
format and the merge do not change when that happens.

Detection reads the CURRENT message only. An earlier request is remembered as a
value, never re-discovered by re-reading the dialogue.

**Recall.** Preferred source is the aggregate the client maintains and sends
with the request: it folds its FULL local history, which the request cannot
carry (`messages` is capped at 20). The per-message copies are the fallback —
they cover a client that doesn't aggregate yet, and they are the provenance
record. Both go through the same merge, so the two paths cannot disagree.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Mapping, Protocol, TypeVar

from pydantic import BaseModel

from lectorium_chat.application.author_lookup import resolve_author
from lectorium_chat.application.author_names import names_match
from lectorium_chat.application.cache_helpers import TTL_7D, cached_llm_json
from lectorium_chat.domain.conversation_attributes import (
    ALL,
    LECTURE_AUTHORS,
    RAW_PREFIX,
    REPLY_LANGUAGE,
    Attribute,
    merge_attributes,
)
from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.observability.timing import stage


log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)

_PROMPTS_DIR = Path(__file__).resolve().parent.parent / "agent" / "prompts"

# Where the client persists the per-message copy, and the key on the terminal
# `done` payload. Same name on both so the round trip is one word to grep.
MESSAGE_FIELD = "attributes"


class ReplyLanguageOut(BaseModel):
    """What the reply-language detector fills. Single-valued by nature, so the
    model is asked for a plain string — no model is ever handed a union."""

    value: str = ""
    label: str = ""
    explicit: bool = False


class AttributeSpec(Protocol):
    """One thing we know how to read out of a message.

    `prompt_name` is the Langfuse-hosted prompt (edited without a deploy); `md`
    is the bundled fallback under `agent/prompts/`. `schema` is what the MODEL
    fills — deliberately per-attribute, because they differ: the language one
    names a locale, the author one names PEOPLE the server must then resolve to
    catalog ids. `build` turns that into the stored `Attribute`, or None when
    the message settled nothing.

    Adding an attribute is one of these plus its prompt — the transport, the
    merge and the clients need no change at all.
    """

    key: str
    prompt_name: str
    md: str
    schema: type[BaseModel]

    async def build(
        self,
        out: Any,
        *,
        catalog_repo: Any,
        request_id: str | None,
        private_repo: Any = None,
        user_id: str = "",
    ) -> Attribute | None: ...


def _bundled(md: str) -> str:
    return (_PROMPTS_DIR / f"{md}.md").read_text(encoding="utf-8")


class ReplyLanguageSpec:
    key = REPLY_LANGUAGE
    prompt_name = "reply-language"
    md = "reply_language"
    schema = ReplyLanguageOut

    async def build(
        self,
        out: ReplyLanguageOut,
        *,
        catalog_repo: Any,
        request_id: str | None,
        private_repo: Any = None,
        user_id: str = "",
    ) -> Attribute | None:
        attr = Attribute(
            value=out.value, label=out.label, explicit=out.explicit,
        )
        return attr if attr.settled() else None


class LectureAuthorsOut(BaseModel):
    """What the lecturer detector fills.

    NAMES, never ids: the model cannot know the catalog's ids, and a guessed one
    would be a filter that silently matches nothing. `everyone` is the request to
    lift a narrowing — it becomes `ALL`, which the merge can carry and an absence
    cannot.

    No `explicit` field, unlike the language: this attribute is only ever set by
    someone ASKING for it (the prompt abstains on a mere mention), so the answer
    is known and asking the model for it just invites disagreement.
    """

    names: list[str] = []
    everyone: bool = False


# Bound on catalog round-trips for one message. Nobody picks nine teachers in a
# sentence; a list that long is a malformed reading, and truncation is logged.
_MAX_AUTHORS = 8


class LectureAuthorsSpec:
    key = LECTURE_AUTHORS
    prompt_name = "lecture-authors"
    md = "lecture_authors"
    schema = LectureAuthorsOut

    async def build(
        self,
        out: LectureAuthorsOut,
        *,
        catalog_repo: Any,
        request_id: str | None,
        private_repo: Any = None,
        user_id: str = "",
    ) -> Attribute | None:
        if out.everyone:
            # No label: "everyone" is not a name, and the wording for it belongs
            # to whoever displays it, in their own language.
            return Attribute(value=[ALL], explicit=True)

        names: list[str] = []
        for raw in out.names:
            name = (raw or "").strip()
            if name and name not in names:
                names.append(name)
        if len(names) > _MAX_AUTHORS:
            log.info(
                "lecture_authors_truncated",
                request_id=request_id, asked=len(names), kept=_MAX_AUTHORS,
            )
            names = names[:_MAX_AUTHORS]
        if not names:
            return None

        hits = await asyncio.gather(*(
            resolve_author(catalog_repo, name) for name in names
        ))
        # A personal library is mostly teachers the curated corpus never heard of,
        # so a name the catalog cannot place is looked for among the speakers this
        # person's OWN uploads recorded — a handful of strings, compared with the
        # same cross-script matcher. Every stored spelling that denotes them is
        # kept («Rohini Suta Prabhu», «H.G. Rohini Suta Prabhu» are one teacher and
        # two rows), so the filter matches whichever the ingest happened to write.
        own_names: list[str] | None = None
        ids: list[str] = []
        labels: list[str] = []
        missing: list[str] = []
        for name, hit in zip(names, hits):
            if hit is not None:
                if hit.id not in ids:
                    ids.append(hit.id)
                    labels.append(hit.full_name)
                continue
            if own_names is None:
                own_names = await _own_speakers(
                    private_repo, user_id, request_id=request_id,
                )
            mine = [stored for stored in own_names if names_match(name, stored)]
            if mine:
                for stored in mine:
                    value = f"{RAW_PREFIX}{stored}"
                    if value not in ids:
                        ids.append(value)
                labels.append(name)
            else:
                missing.append(name)
        if missing:
            log.info(
                "lecture_authors_unresolved",
                request_id=request_id, names=missing, resolved=len(ids),
            )
        if not ids:
            # Nobody asked for silence. A filter on a teacher the corpus does not
            # have would empty every answer from here on and read as "there is
            # nothing on this" — so the request is dropped instead, and the turn
            # answers from everyone as it did before.
            return None
        # A name we could not place is left out rather than widening the filter
        # back: the user named who they wanted, and the ones we found are what we
        # can honestly serve.
        return Attribute(value=ids, label=", ".join(labels), explicit=True)


ATTRIBUTE_SPECS: tuple[AttributeSpec, ...] = (
    ReplyLanguageSpec(), LectureAuthorsSpec(),
)



async def _own_speakers(
    private_repo: Any, user_id: str, *, request_id: str | None,
) -> list[str]:
    """Speaker names across this person's own uploads, or [] when unavailable.

    Read only when the catalog failed to place a name — the common case (a corpus
    author) costs nothing extra.
    """
    if private_repo is None or not user_id:
        return []
    try:
        return list(await private_repo.get_own_author_names(user_id))
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "own_speakers_lookup_failed", request_id=request_id, error=str(exc),
        )
        return []


class _LLMForAttributes(Protocol):
    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T: ...


def _parse(raw: Any) -> Attribute | None:
    try:
        attr = Attribute.model_validate(raw)
    except Exception:  # noqa: BLE001 — untrusted client payload
        return None
    return attr if attr.settled() else None


def _bag(raw: Any) -> dict[str, Attribute]:
    """Validate one wire map. Anything unreadable is treated as absent rather
    than fatal — this is client input, and a malformed entry must not cost the
    turn its other attributes."""
    if not isinstance(raw, Mapping):
        return {}
    out: dict[str, Attribute] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        attr = _parse(value)
        if attr is not None:
            out[key] = attr
    return out


def remembered_attributes(
    history: list[dict[str, Any]] | None,
    client_attributes: Any = None,
) -> dict[str, Attribute]:
    """What the dialogue had already settled, before this message.

    The per-message copies are folded oldest-first so a later turn's value wins,
    then the client's aggregate is laid over the top with the same rule. The
    aggregate is preferred because it saw the whole conversation; folding the
    messages is what keeps a non-aggregating client working.
    """
    from_messages: dict[str, Attribute] = {}
    for entry in history or []:
        if entry.get("role") != "assistant":
            continue
        from_messages = merge_attributes(
            detected=_bag(entry.get(MESSAGE_FIELD)), remembered=from_messages,
        )
    return merge_attributes(
        detected=_bag(client_attributes), remembered=from_messages,
    )


async def detect_attributes(
    user_query: str,
    *,
    llm: _LLMForAttributes,
    request_id: str | None = None,
    model: str | None = None,
    kv_cache: Any | None = None,
    callbacks: list[Any] | None = None,
    catalog_repo: Any | None = None,
    private_repo: Any | None = None,
    user_id: str = "",
    specs: tuple[AttributeSpec, ...] = ATTRIBUTE_SPECS,
) -> dict[str, Attribute]:
    """Read every registered attribute off this message, concurrently.

    An attribute the message says nothing about is simply absent — a normal
    outcome, not a failure, and the caller then keeps what the dialogue already
    settled. Errors are absences too: an attribute is a hint, never a reason to
    lose a turn.
    """
    query = (user_query or "").strip()
    if not query or not specs:
        return {}

    results = await asyncio.gather(*(
        _detect_one(
            spec, query, llm=llm, request_id=request_id, model=model,
            kv_cache=kv_cache, callbacks=callbacks, catalog_repo=catalog_repo,
            private_repo=private_repo, user_id=user_id,
        )
        for spec in specs
    ))
    return {
        spec.key: attr
        for spec, attr in zip(specs, results)
        if attr is not None
    }


async def _detect_one(
    spec: AttributeSpec,
    query: str,
    *,
    llm: _LLMForAttributes,
    request_id: str | None,
    model: str | None,
    kv_cache: Any | None,
    callbacks: list[Any] | None,
    catalog_repo: Any | None,
    private_repo: Any | None = None,
    user_id: str = "",
) -> Attribute | None:
    prompt = prompt_with_fallback(
        spec.prompt_name, fallback=lambda: _bundled(spec.md),
    )
    effective_model = prompt.config.get("model") or model
    messages: list[Message] = [
        {"role": "system", "content": prompt.text},
        {"role": "user", "content": query},
    ]

    async def _call() -> Any:
        async with stage(f"attribute.{spec.key}", request_id=request_id):
            return await llm.structured_output(
                messages,
                spec.schema,
                model=effective_model,
                callbacks=callbacks,
                run_name=f"attribute_{spec.key}",
            )

    try:
        if kv_cache is not None:
            # Deterministic at temperature 0, so a repeat («спасибо»,
            # «подробнее») costs nothing the second time. The cached shape is
            # the MODEL's output, not the built attribute: `build` may consult
            # the catalog, whose contents change under us.
            out = await cached_llm_json(
                kv_cache,
                ns="chat_attribute",
                key_parts={
                    "k": spec.key, "q": query, "model": effective_model or "",
                },
                ttl_s=TTL_7D,
                schema=spec.schema,
                factory=_call,
            )
        else:
            out = await _call()
        detected = await spec.build(
            out, catalog_repo=catalog_repo, request_id=request_id,
            private_repo=private_repo, user_id=user_id,
        )
    except Exception as exc:  # noqa: BLE001 — never fail the turn on a hint
        log.warning(
            "attribute_detection_failed",
            request_id=request_id, attribute=spec.key, error=str(exc),
        )
        return None

    if detected is None or not detected.settled():
        return None
    log.info(
        "attribute_detected",
        request_id=request_id,
        attribute=spec.key,
        value=detected.value,
        explicit=detected.explicit,
    )
    return detected
