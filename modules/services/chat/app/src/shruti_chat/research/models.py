"""Pydantic + dataclass models for the research pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from pydantic import BaseModel, Field


# ---- Research note envelope -----------------------------------------------


class ResearchNote(TypedDict, total=False):
    """One retrieved corpus note ("envelope") as the synthesizer consumes it.

    This is the dict shape minted by `agent.tools._envelope.lecture_to_envelope`
    / `library_to_envelope` and carried through `tool_results`, the fanout
    `chunks`, and the planner outputs. `total=False` because the lane that
    produced a note decides which optional keys it carries (lecture notes carry
    `meta.start_ms/end_ms`; verse/commentary notes carry an address label and
    author metadata; only reranked notes carry `rerank_score`).

    Keys:
      type   — note family: "lecture" | "verse" | "media" | "commentary" | …
      ref    — integer alias number; the target the `[^N]` marker resolves to.
      label  — human address label (e.g. "ШБ 4.1.39"), "" for lecture chunks.
      text   — the note's verbatim corpus text (what the synthesizer cites).
      lang   — corpus language of `text`.
      score  — retrieval (cosine) score in [0, 1].
      meta   — lane-specific metadata (timecodes / address / author / kind …).
    """

    type: str
    ref: int
    label: str
    text: str
    lang: str
    score: float
    meta: dict[str, Any]
    rerank_score: float
    sub_query_id: int


# ---- LLM-emitted structured outputs ---------------------------------------


SubQueryType = Literal[
    "definition", "scripture_ref", "contrast", "biographical", "general",
]


class SubQuery(BaseModel):
    """One typed sub-question produced by `query_planner.plan_queries`.

    `id` is a 0-based index assigned by the planner; envelopes coming out of
    the fanout for this sub-query carry it in `meta["sub_query_id"]` so the
    downstream synthesis planner can group notes by sub-question.

    `alt_phrasings` are optional same-meaning paraphrases used to widen the
    embedding recall for the SAME sub-question — they share `id`, they are
    NOT separate sub-questions.
    """

    id: int
    type: SubQueryType
    text: str
    alt_phrasings: list[str] = Field(default_factory=list, max_length=2)


class QueryPlan(BaseModel):
    """Output of `query_planner.plan_queries`. 1-4 typed sub-questions.

    On a simple question the planner returns a single sub_query (equivalent
    to the old `query_expander` behaviour). On a multi-intent question it
    decomposes into 2-4 sub_queries of different types so the downstream
    fanout retrieves distinct themes instead of paraphrases of one center.
    """

    sub_queries: list[SubQuery] = Field(default_factory=list, max_length=4)


class Thesis(BaseModel):
    """One thesis paragraph in the synthesis outline.

    `thesis` is the one-sentence statement the synthesizer should expand
    into one short paragraph. `supporting_notes` are 1-N indices (1-based,
    matching the `[^N]` markers in the rendered notes block) that back
    this thesis — the synthesizer cites ONLY these notes when writing
    this paragraph and emits one `[^N]` at the paragraph end.

    `header` is an optional 3-5 word terse label that summarizes the
    claim (NO markdown, NO punctuation at the end). When set, the
    synthesizer renders it as `## header` (markdown H2) on its own line
    above the paragraph — gives the answer scannable structure for multi-
    thesis replies. Skip on single-thesis answers.

    `sub_query_types` is diagnostic-only: lists the sub-question types
    of supporting notes so we can grade outline coherence in Langfuse
    without re-reading individual chunks.
    """

    thesis: str
    header: str | None = None
    supporting_notes: list[int] = Field(default_factory=list, min_length=1)
    sub_query_types: list[str] = Field(default_factory=list)


class Outline(BaseModel):
    """Output of `outline_builder.build_outline`. Plan the synthesizer
    writes against when `outline.theses` is non-empty.

    Three meaningful states downstream:
      - `outline = None`             → planner failed; synthesizer runs
                                       in free-form mode (legacy behaviour).
      - `Outline(theses=[])`         → planner deliberately rejected all
                                       notes; synthesizer emits refusal.
      - `Outline(theses=[...])`      → synthesizer writes one paragraph
                                       per thesis, citing only that
                                       thesis's `supporting_notes`.

    `intro` is an optional one-sentence preamble that frames a multi-
    thesis answer (skip on single-thesis answers). `conclusion` is an
    optional final paragraph that ties the theses together at the end —
    include only on 3+ theses where the synthesis genuinely benefits
    from a closing thought. Neither carries a citation.

    `skipped_notes` / `skipped_reason` are diagnostic — show which notes
    the planner saw and chose not to use, helping us tune relevance
    thresholds upstream.
    """

    intro: str | None = None
    theses: list[Thesis] = Field(default_factory=list, max_length=5)
    conclusion: str | None = None
    skipped_notes: list[int] = Field(default_factory=list)
    skipped_reason: str | None = None


class TopicExtractionResult(BaseModel):
    """Output of `topic_extractor.extract_topics`. 0-5 short topic strings
    (1-4 words each) extracted from the user query for matching against
    topic-attributions in the LONG path."""

    topics: list[str] = Field(default_factory=list, max_length=10)


# ---- Attribution lookup ---------------------------------------------------


@dataclass(frozen=True)
class AttributionRef:
    """One ref entry as stored in `attributions.refs` JSONB and returned
    from find_attributions matches.

    `language` optionally scopes a ref to one answer language ("" =
    language-agnostic, e.g. a verse; "en"/"ru" = a language-specific resource
    like an EN vs RU lecture of the same talk)."""

    ref_kind: str   # "verse" | "document" | "title" | "track"
    target_id: str
    language: str = ""


@dataclass(frozen=True)
class AttributionMatch:
    """A single attribution returned by `find_attributions`."""

    attribution_id: str
    kind: Literal["pinned", "boost", "memory"]
    refs: list[AttributionRef]
    score: float
    stage: Literal["native", "cross"]    # which lookup stage produced it


@dataclass(frozen=True)
class MemoryResolution:
    """A resolved curator-memory match for one turn, as produced by
    `pipeline._resolve_memory` and consumed by the sufficiency gate +
    `_attach_memory`.

    `note` is the non-citable background briefing; `envelopes` are the curator's
    refs resolved into citable chunks; `score`/`stage` are the lookup match
    strength used by the sufficiency gate (a LOOSE match still injects the note
    but must NOT short-circuit the corpus sweep — that needs a stronger bar than
    the inject threshold). `attribution_id` is None on no match."""

    note: str | None = None
    attribution_id: str | None = None
    envelopes: list[dict[str, Any]] = field(default_factory=list)
    score: float = 0.0
    stage: Literal["native", "cross"] = "native"

    @property
    def matched(self) -> bool:
        return self.attribution_id is not None


# ---- Fanout / coverage ----------------------------------------------------


@dataclass
class FanoutResult:
    """Aggregated, ranked output of one or more fanout rounds.

    `chunks` is the flat top-K list (already sorted by score desc, possibly
    boosted). `by_kind` preserves per-corpus partition for the coverage gate
    (which counts lectures separately). `max_score` is the best score across
    all chunks (also reflects topic-boost when applied)."""

    chunks: list[Any] = field(default_factory=list)
    by_kind: dict[str, list[Any]] = field(default_factory=dict)
    max_score: float = 0.0
    rounds_executed: int = 0


# ---- ResearchResult — what pipeline.run_research returns ------------------


# ---- LocateResult — what locate.run_locate returns -----------------------


@dataclass(frozen=True, slots=True)
class LocateChapter:
    """One chapter inside a located region: address tokens + heading."""

    tokens: str   # "7.5"
    title: str    # "Махараджа Прахлада, святой сын Хираньякашипу"


@dataclass(frozen=True, slots=True)
class LocateRegion:
    """A located region of a book — a canto (or the book itself for
    single-level books like BG) plus the chapters the narrative spans.

    `region_token` is the canto token ("7") for 3-level books, or the
    chapter token for 2-level books. `region_label` is the canto heading
    (or book short-name). Rendered as one ChapterCard on the client."""

    source_id: str
    region_token: str
    region_label: str
    chapters: tuple[LocateChapter, ...]
    score: float = 0.0


@dataclass(frozen=True, slots=True)
class LocateVerse:
    """A located individual verse (verse-granularity answer)."""

    source_id: str
    tokens: str
    addr_label: str
    score: float = 0.0


@dataclass
class LocateResult:
    """Output of `locate.run_locate`, consumed by `locate_worker_node`.

    Exactly one of `regions` / `verses` is normally populated, chosen by
    the question's granularity (chapter-level vs verse-level). `truncated`
    is True when more regions matched than the display cap — the worker
    surfaces an "основные места" note so the cut isn't silent.
    """

    regions: list[LocateRegion] = field(default_factory=list)
    verses: list[LocateVerse] = field(default_factory=list)
    truncated: bool = False
    matched_attribution_ids: list[str] = field(default_factory=list)


@dataclass
class ResearchResult:
    """Final output of the pipeline, consumed by the synthesizer.

    `authoritative_refs` — chunks fetched from question-attribution refs.
    PINNED at the top of synthesizer notes. Empty in the LONG path.

    `research_chunks` — everything else (fanout in LONG, supplementary fanout
    in SHORT). Sorted by score (boosted when topic-attribution matched).

    `matched_question_ids` / `matched_topic_ids` — for observability +
    optional rendering of "based on N curated questions" hints in the UI.

    `memory_note` — a curator memory note matched for this turn, injected by
    the synthesizer as NON-citable background context (shapes the prose, never
    cited). None when no memory matched. `matched_memory_id` is for
    observability. A matched memory's refs are folded into `research_chunks`
    (the citable pool) like boost refs.
    """

    authoritative_refs: list[Any] = field(default_factory=list)
    research_chunks: list[Any] = field(default_factory=list)
    matched_question_ids: list[str] = field(default_factory=list)
    matched_topic_ids: list[str] = field(default_factory=list)
    memory_note: str | None = None
    matched_memory_id: str | None = None
