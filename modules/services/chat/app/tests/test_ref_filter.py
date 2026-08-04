"""Unit tests for `track_references.tokens` parser and matcher.

The matcher is what powers the `ref_prefix` / `ref_from` / `ref_to`
filters on `list_tracks`. Real token shapes were sampled from
`current.db` — see the dataset constants below.
"""

from __future__ import annotations

import pytest

from shruti_chat.domain.scripture_ref import (
    matches_ref as _matches_ref,
    parse_tokens as _parse_tokens,
)


@pytest.mark.parametrize(
    "tokens,expected",
    [
        # 2-level (БГ): chapter.verse
        ("2.13", ([2], 13, 13)),
        ("7.1", ([7], 1, 1)),
        ("4.23", ([4], 23, 23)),
        # 3-level (ШБ / ЧЧ): canto.chapter.verse
        ("1.2.6", ([1, 2], 6, 6)),
        ("5.5.3", ([5, 5], 3, 3)),
        ("7.9.10", ([7, 9], 10, 10)),
        # 1-level (ИШО)
        ("10", ([], 10, 10)),
        # explicit ranges
        ("2.51-54", ([2], 51, 54)),
        ("10.1-3", ([10], 1, 3)),
        # short-form right side
        ("7.91-2", ([7], 91, 92)),
        ("6.149-50", ([6], 149, 150)),
        # SAME-prefix full-form range: the right side repeats the prefix, so use
        # its last component as the EXACT upper bound (must NOT widen to 99999,
        # which would spill into the rest of the chapter).
        ("1.2.6-1.2.18", ([1, 2], 6, 18)),
        ("2.13-2.20", ([2], 13, 20)),
        # cross-prefix range (rare); we widen `to` so the start prefix matches
        ("7.28-8.6", ([7], 28, 99999)),
        ("7.6.29-7.7.9", ([7, 6], 29, 99999)),
        # en-dash / em-dash normalisation
        ("2.51–54", ([2], 51, 54)),
        ("2.51—54", ([2], 51, 54)),
        # whitespace tolerance
        ("  2.13  ", ([2], 13, 13)),
        # unparseable
        ("", None),
        ("Dictation", None),
        (None, None),
    ],
)
def test_parse_tokens(tokens, expected):
    assert _parse_tokens(tokens) == expected


@pytest.mark.parametrize(
    "tokens,user_prefix,vfrom,vto,expected",
    [
        # «БГ 2» (chapter 2, any verse) — accept all chapter-2 refs
        ("2.13", [2], None, None, True),
        ("2.51-54", [2], None, None, True),
        ("10.1-3", [2], None, None, False),
        ("20.5", [2], None, None, False),   # 20 must NOT match prefix=2
        # «БГ 2 стихи 10–30»
        ("2.13", [2], 10, 30, True),
        ("2.51-54", [2], 10, 30, False),
        ("2.8-15", [2], 10, 30, True),       # overlap left edge
        ("2.28-35", [2], 10, 30, True),      # overlap right edge
        ("10.1-3", [2], 10, 30, False),
        # «ШБ 2.3» (canto 2, chapter 3)
        ("2.3.15", [2, 3], None, None, True),
        ("2.3.1", [2, 3], None, None, True),
        ("2.4.1", [2, 3], None, None, False),
        ("1.3.15", [2, 3], None, None, False),
        # «ШБ песнь 2» (canto only)
        ("2.3.15", [2], None, None, True),
        ("2.5.1", [2], None, None, True),
        ("1.3.15", [2], None, None, False),
        # «ШБ 2.3 стихи 10–30»
        ("2.3.15", [2, 3], 10, 30, True),
        ("2.3.5", [2, 3], 10, 30, False),
        ("2.3.29-32", [2, 3], 10, 30, True),
        # «ИШО мантра 10» — empty prefix + range on last
        ("10", [], 10, 10, True),
        ("11", [], 10, 10, False),
        ("10", [], 5, 15, True),
        # ref_prefix reaches into a token's range (single-verse query)
        ("2.51-54", [2, 53], None, None, True),
        ("2.51-54", [2, 60], None, None, False),
        # user prefix longer than the token's ladder → reject
        ("2", [2, 3], None, None, False),
        # cross-prefix widening matches start chapter but not end chapter
        ("7.28-8.6", [7], 28, 28, True),
        ("7.28-8.6", [8], None, None, False),  # false negative we accept
    ],
)
def test_matches_ref(tokens, user_prefix, vfrom, vto, expected):
    parsed = _parse_tokens(tokens)
    assert parsed is not None
    assert _matches_ref(parsed, user_prefix, vfrom, vto) is expected
