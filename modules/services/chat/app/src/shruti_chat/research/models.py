"""Pydantic + dataclass models for the research pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field


# ---- LLM-emitted structured outputs ---------------------------------------


class ExpansionResult(BaseModel):
    """Output of `query_expander.expand_query`. The expander does ONE thing:
    generate diversified search queries. Intent/entities are NOT re-extracted
    — router_turn has already classified the intent and the seed args travel
    through `router_args` directly."""

    queries: list[str] = Field(default_factory=list, max_length=10)


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
