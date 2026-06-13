"""AddressClassifier — claims bare scripture references ("БГ 2.13",
"Мадхья лила 17.80", "गीता २.१३") for the `show_verse` path, deterministically,
before the LLM router runs.

Why pre-router: the LLM router lossily collapses references — e.g. it turned
"Мадхья лила 17.80" into `source_id="CC"` (dropping the lila, which is then
unrecoverable: both CC Adi and CC Madhya have a 17.80). Reading the RAW query
keeps the lila and resolves it.

Design (measured against the real catalog + library DBs):
  1. normalize non-ASCII digits (Devanagari ०-९, Bengali ০-৯) → ASCII.
  2. find a numeric address (loose separators); no number → not ours.
  3. resolve the book: exact abbrev / fuzzy full-name across ALL locales,
     or a structural default by address depth (3-level → SB) when no book.
  4. VALIDATE candidates against `library_verses` existence — a unique
     existing verse wins; zero / ambiguous → return None (fall through).
Gates: a question about the verse ("что значит BG 2.13") or book words we
can't resolve → None, so research/LLM handles it.

The pure parsing + decision logic takes injected `resolve_book` /
`verse_exists` callables so it's unit-testable without a DB; `classify`
wires them from the per-turn `TurnContext`.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Awaitable, Callable

from shruti_chat.agent.classify.base import ClassifierContext
from shruti_chat.agent.tools._helpers import BOOK_PREFIX
from shruti_chat.domain.routing import RoutingDecision

# Book prefixes (ru + en) longest-first so "ЧЧ Мадхйа" wins over "ЧЧ".
_PREFIXES = sorted(
    {p for m in BOOK_PREFIX.values() for p in m.values()},
    key=len,
    reverse=True,
)

# A numeric address: digit groups joined by . space : , - (any mix).
_NUM_RE = re.compile(r"\d+(?:[.\s:,_\-–]*\d+)*")

# Words that signal the user wants an ANSWER about the verse, not just the
# verse — route those to research, not show_verse.
_QUESTION_RE = re.compile(
    r"\b(что|значит|почему|зачем|как|расскажи|объясни|смысл|"
    r"what|why|how|explain|means?|meaning)\b|\?",
    re.IGNORECASE,
)
# Structural words sitting between the book and the number ("глава", "стих",
# "lila", …) — stripped so they don't pollute the book text.
_STOP_RE = re.compile(
    r"\b(глав[аы]|стих|текст|песн[ьи]|канто|лила|"
    r"chapter|verse|text|canto|lila|"
    r"cap[íi]tulo|kapitel|chapitre|capitolo|rozdział|fejezet|verso|vers|verset)\b",
    re.IGNORECASE,
)

# Confidence floor for a fuzzy book match (resolve() returns 0..1).
_BOOK_CONF_FLOOR = 0.70
# Below this many characters we don't even try (a stray "2.13" inside chatter
# is still fine — this only guards truly empty input).
_MIN_CHARS = 2


@dataclass(frozen=True)
class ParsedRef:
    """Result of the pure (DB-free) parse step."""

    booktext: str            # the non-numeric, non-stopword remainder (may be "")
    ref_candidates: list[str]  # normalized token strings to try, e.g. ["2.13"]
    has_question: bool
    has_alpha: bool          # booktext contains letters (a book was named)


def _normalize_digits(text: str) -> str:
    out: list[str] = []
    for ch in text:
        if ch.isdigit() and not ch.isascii():
            try:
                out.append(str(unicodedata.digit(ch)))
                continue
            except (TypeError, ValueError):
                pass
        out.append(ch)
    return out and "".join(out) or text


def _ref_candidates(numstr: str) -> list[str]:
    """Normalized token candidates from a raw number run.

    Separators collapse to dots. A no-separator run ("213") expands into
    2-level split candidates ("2.13", "21.3") — the existence-check picks the
    real one. We do NOT 3-split here (the only 3-level source, SB, is virtually
    always written with separators)."""
    parts = [p for p in re.split(r"[.\s:,_\-–]+", numstr.strip()) if p]
    cands: list[str] = []
    if len(parts) >= 2:
        cands.append(".".join(parts))
    elif len(parts) == 1 and parts[0].isdigit():
        d = parts[0]
        for i in range(1, len(d)):
            cands.append(f"{d[:i]}.{d[i:]}")
    # de-dup, preserve order
    seen: set[str] = set()
    return [c for c in cands if not (c in seen or seen.add(c))]


def parse_ref(query: str) -> ParsedRef | None:
    """Pure parse: returns None when there's no numeric address at all."""
    if not query or len(query.strip()) < _MIN_CHARS:
        return None
    norm = _normalize_digits(query)
    m = _NUM_RE.search(norm)
    if not m:
        return None
    numstr = m.group(0)
    rest = norm[: m.start()] + " " + norm[m.end():]
    booktext = _QUESTION_RE.sub(" ", _STOP_RE.sub(" ", rest))
    booktext = " ".join(booktext.split()).strip()
    return ParsedRef(
        booktext=booktext,
        ref_candidates=_ref_candidates(numstr),
        has_question=bool(_QUESTION_RE.search(norm)),
        has_alpha=bool(re.search(r"[^\W\d_]", booktext)),
    )


ResolveBook = Callable[[str], Awaitable[list[tuple[str, float]]]]
VerseExists = Callable[[str, str], Awaitable[bool]]


async def decide(
    parsed: ParsedRef,
    *,
    resolve_book: ResolveBook,
    verse_exists: VerseExists,
    default_sources: Callable[[int], Awaitable[list[str]]],
) -> tuple[str, str] | None:
    """Resolve + existence-validate. Returns (source_id, tokens) or None.

    Injected callables keep this unit-testable:
      resolve_book(text)     -> [(source_id, confidence), ...] best-first
      verse_exists(sid, tok) -> bool
      default_sources(depth) -> [source_id, ...]  (structural fallback)
    """
    if not parsed.ref_candidates:
        return None
    if parsed.has_question:
        return None  # "что значит BG 2.13" → research

    if parsed.booktext:
        cands = await resolve_book(parsed.booktext)
        src_ids = [sid for sid, conf in cands if conf >= _BOOK_CONF_FLOOR]
        if not src_ids:
            # Book words present but unresolved — don't guess; let the LLM try.
            return None
    elif parsed.has_alpha:
        return None
    else:
        # No book at all → structural default by the (first) candidate's depth.
        depth = max(rc.count(".") + 1 for rc in parsed.ref_candidates)
        src_ids = await default_sources(depth)

    hits: list[tuple[str, str]] = []
    for sid in src_ids:
        for rc in parsed.ref_candidates:
            if await verse_exists(sid, rc):
                pair = (sid, rc)
                if pair not in hits:
                    hits.append(pair)
    return hits[0] if len(hits) == 1 else None


class AddressClassifier:
    """Chain link: bare scripture reference → `show_verse`."""

    name = "address"

    async def classify(self, query: str, ctx: ClassifierContext) -> RoutingDecision | None:
        parsed = parse_ref(query)
        if parsed is None:
            return None
        repo = ctx.catalog_repo
        lib = ctx.library_db_path
        if repo is None or lib is None:
            return None

        async def resolve_book(text: str) -> list[tuple[str, float]]:
            # lang=None searches source names across ALL locales (БГ ru and
            # Bhagavad-gita en both resolve to the same id).
            ents = await repo.resolve("source", text, lang=None, limit=6)
            best: dict[str, float] = {}
            for e in ents:
                best[e.id] = max(best.get(e.id, 0.0), e.confidence)
            return sorted(best.items(), key=lambda kv: -kv[1])

        async def verse_exists(source_id: str, tokens: str) -> bool:
            from shruti_chat.indexer.library.repo import fetch_verse_body

            return await fetch_verse_body(lib, source_id, tokens) is not None

        async def default_sources(depth: int) -> list[str]:
            # 3-level → SB (the only 3-level source). 2-level → BG (the most-
            # referenced 2-level text; existence-check still guards). 1-level
            # is too ambiguous to default.
            abbr = "SB" if depth >= 3 else "BG" if depth == 2 else None
            if abbr is None:
                return []
            cands = await resolve_book(abbr)
            return [sid for sid, conf in cands if conf >= _BOOK_CONF_FLOOR][:1]

        hit = await decide(
            parsed,
            resolve_book=resolve_book,
            verse_exists=verse_exists,
            default_sources=default_sources,
        )
        if hit is None:
            return None
        source_id, tokens = hit
        return RoutingDecision(
            intent="show_verse",
            confidence=1.0,
            extracted_args={"source_id": source_id, "tokens": tokens},
        )
