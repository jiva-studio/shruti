"""`ChunkEnvelope` is the one definition of the LLM-facing chunk shape.

It used to be documentation only: a frozen dataclass with a 30-line docstring
describing the contract, **never instantiated**. The dicts were hand-assembled
in `agent/tools/_envelope.py`, and the same contract was restated a second time
as `ResearchNote` in `research/models.py`. A contract with two copies and no
constructor drifts by default.

These dicts are serialised into prompts, so the wire form is behaviour: a
renamed key or a reordering is a silent prompt change.
"""

from __future__ import annotations

from shruti_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import Chunk, ChunkEnvelope, LibraryChunk


_WIRE_KEYS = ["type", "ref", "label", "text", "lang", "score", "meta"]


def test_to_dict_key_order_is_the_historical_one() -> None:
    env = ChunkEnvelope(
        type="lecture", ref=1, label="", text="t", lang="ru", score=0.5, meta={},
    )
    assert list(env.to_dict()) == _WIRE_KEYS


def test_lecture_envelope_matches_the_type() -> None:
    chunk = Chunk(
        track_id="track_X", lang="ru", start_ms=1000, end_ms=2000,
        text="body", reference_source_id=None,
    )
    out = lecture_to_envelope(chunk, alias_map=TurnAliasMap(), score=0.7)

    assert list(out) == _WIRE_KEYS
    assert out["type"] == "lecture"
    # `track_id` must never reach the model — it only ever sees `ref`, and the
    # expander resolves it server-side.
    assert "track_id" not in out
    assert out["meta"]["start_ms"] == 1000


def test_library_envelope_matches_the_type() -> None:
    chunk = LibraryChunk(
        item_id="v1", item_kind="verse", source_id="BG", tokens="2.13",
        author_id=None, doc_date=None, lang="ru", segment_index=0,
        text="verse body", addr_label="БГ 2.13",
    )
    out = library_to_envelope(chunk, alias_map=TurnAliasMap(), score=None)

    assert list(out) == _WIRE_KEYS
    assert out["type"] == "verse"
    assert out["label"] == "БГ 2.13"
    # The model addresses verses by meta, not by ref.
    assert out["meta"]["source_id"] == "BG"
    assert out["meta"]["tokens"] == "2.13"


def test_envelope_round_trips_through_the_type() -> None:
    """Anything the builders emit must be expressible as the dataclass —
    otherwise the dict has grown a field the contract doesn't know about."""
    chunk = Chunk(
        track_id="track_X", lang="en", start_ms=0, end_ms=10,
        text="t", reference_source_id="BG",
    )
    out = lecture_to_envelope(chunk, alias_map=TurnAliasMap(), score=0.1)

    assert ChunkEnvelope(**out).to_dict() == out
