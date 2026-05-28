"""Pydantic + dataclass models for the research pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field


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
    synthesizer renders it as `**header**` on its own line above the
    paragraph — gives the answer scannable structure for longer multi-
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
    from find_attributions matches."""

    ref_kind: str   # "verse" | "document"
    target_id: str


@dataclass(frozen=True)
class AttributionMatch:
    """A single attribution returned by `find_attributions`."""

    attribution_id: str
    kind: Literal["question", "topic"]
    refs: list[AttributionRef]
    score: float
    stage: Literal["native", "cross"]    # which lookup stage produced it


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


@dataclass
class ResearchResult:
    """Final output of the pipeline, consumed by the synthesizer.

    `authoritative_refs` — chunks fetched from question-attribution refs.
    PINNED at the top of synthesizer notes. Empty in the LONG path.

    `research_chunks` — everything else (fanout in LONG, supplementary fanout
    in SHORT). Sorted by score (boosted when topic-attribution matched).

    `matched_question_ids` / `matched_topic_ids` — for observability +
    optional rendering of "based on N curated questions" hints in the UI.
    """

    authoritative_refs: list[Any] = field(default_factory=list)
    research_chunks: list[Any] = field(default_factory=list)
    matched_question_ids: list[str] = field(default_factory=list)
    matched_topic_ids: list[str] = field(default_factory=list)
