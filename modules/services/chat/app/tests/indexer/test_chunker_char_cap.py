"""chunk_reviewed must emit embeddable chunks even from degenerate blocks.

A `verse:translation` block carrying a whole translation in one zero-duration
block (observed at 26k+ chars in prod) used to surface as a single oversize
chunk that OpenRouter rejects with 200 + empty `data`, so the track never got
marked indexed and re-processed every run. The char cap splits it.
"""

from __future__ import annotations

from shruti_chat.indexer.chunker import MAX_CHARS, chunk_reviewed


def test_oversize_block_is_split_below_cap() -> None:
    big = "word " * 8000  # ~40k chars, no sentence boundaries lost
    reviewed = {
        "trackId": "track_x",
        "language": "en",
        "blocks": [
            {"type": "verse:translation", "start": 1000, "end": 1000, "text": big},
        ],
    }
    chunks = chunk_reviewed(reviewed)
    assert len(chunks) > 1
    assert all(len(c.text) <= MAX_CHARS for c in chunks)
    # window metadata is shared across the split pieces
    assert all(c.track_id == "track_x" and c.start_ms == 1000 for c in chunks)


def test_normal_window_is_untouched() -> None:
    reviewed = {
        "trackId": "track_y",
        "language": "en",
        "blocks": [
            {"type": "sentence", "start": 0, "end": 3000, "text": "hello there"},
            {"type": "sentence", "start": 3000, "end": 6000, "text": "general kenobi"},
        ],
    }
    chunks = chunk_reviewed(reviewed)
    assert len(chunks) == 1
    assert chunks[0].text == "hello there general kenobi"


def test_single_unbroken_token_is_hard_sliced() -> None:
    reviewed = {
        "trackId": "track_z",
        "language": "en",
        "blocks": [
            {"type": "sentence", "start": 0, "end": 1000, "text": "x" * (MAX_CHARS * 2 + 5)},
        ],
    }
    chunks = chunk_reviewed(reviewed)
    assert all(len(c.text) <= MAX_CHARS for c in chunks)
    assert "".join(c.text for c in chunks) == "x" * (MAX_CHARS * 2 + 5)
