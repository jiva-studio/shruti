"""How this corpus addresses scripture: parsing and matching a reference.

A reference is a dot-separated numeric ladder — "2.13", "1.2.6" — optionally
ending in a range ("2.51-54", and the "7.91-2" short-form). Two levels for the
Bhagavad-gītā (chapter.verse), three for Śrīmad-Bhāgavatam and Caitanya-
caritāmṛta (canto.chapter.verse), one for Īśopaniṣad (mantra). A BARE chapter
covers the whole chapter, which is what makes «лекции по БГ 10» answerable.

These rules are domain knowledge, not persistence: the same ones decide which
lectures a chapter question may return (`find_tracks_worker`) and which rows the
catalog filter keeps (`sqlite_catalog_repository`).

Pure: no IO, no dependencies, so a unit test costs nothing to run.
"""

from __future__ import annotations


def parse_tokens(tokens: str | None) -> tuple[list[int], int, int] | None:
    """Parse a token string into `(prefix_parts, last_from, last_to)`.

    The token's full numeric ladder is `[*prefix_parts, last_from..last_to]`;
    the last slot is always a range (collapsed to from==to for a scalar).

    Examples (real shapes from current.db):
      "2.13"          -> ([2], 13, 13)
      "1.2.6"         -> ([1, 2], 6, 6)
      "10"            -> ([], 10, 10)
      "2.51-54"       -> ([2], 51, 54)
      "7.91-2"        -> ([7], 91, 92)       # short-form
      "6.149-50"      -> ([6], 149, 150)
      "7.28-8.6"      -> ([7], 28, 99999)    # cross-prefix; widen "to"
      "7.6.29-7.7.9"  -> ([7, 6], 29, 99999)
    Returns None for empty / unparseable (e.g. "Dictation", "").
    """
    if not tokens:
        return None
    s = tokens.strip().replace("–", "-").replace("—", "-")
    if not s:
        return None
    if "-" in s:
        left, right = s.rsplit("-", 1)
        left = left.strip()
        right = right.strip()
    else:
        left = s
        right = None
    try:
        left_ints = [int(p) for p in left.split(".") if p]
    except ValueError:
        return None
    if not left_ints:
        return None
    prefix = left_ints[:-1]
    from_v = left_ints[-1]
    if right is None:
        return (prefix, from_v, from_v)
    if "." in right:
        # A dotted right side is either a SAME-prefix full-form range
        # ("1.2.6-1.2.18" → prefix [1,2], 6..18) or a genuine cross-prefix
        # range ("7.28-8.6"). Parse the right ladder: when its prefix equals
        # the left prefix, use its last component as the EXACT upper bound
        # (so "1.2.6-1.2.18" doesn't spill into 1.2.19+). Only a real
        # cross-prefix range keeps the "from from_v onwards" approximation.
        try:
            right_ints = [int(p) for p in right.split(".") if p]
        except ValueError:
            right_ints = []
        if right_ints and right_ints[:-1] == prefix:
            return (prefix, from_v, right_ints[-1])
        return (prefix, from_v, 99999)
    try:
        right_int = int(right)
    except ValueError:
        return None
    # Short-form right side ("91-2" → 91..92, "149-50" → 149..150): if
    # the right value has fewer digits than the left, pad with left's
    # leading digits.
    if right_int < from_v:
        ls, rs = str(from_v), str(right_int)
        if len(rs) < len(ls):
            padded = ls[: len(ls) - len(rs)] + rs
            try:
                to_v = int(padded)
                if to_v < from_v:
                    to_v = right_int
            except ValueError:
                to_v = right_int
        else:
            to_v = right_int
    else:
        to_v = right_int
    return (prefix, from_v, to_v)


def matches_ref(
    parsed: tuple[list[int], int, int],
    user_prefix: list[int],
    user_from: int | None,
    user_to: int | None,
) -> bool:
    """True if `parsed` matches `user_prefix` + optional `[user_from, user_to]`.

    Token's ladder must START WITH `user_prefix` (each user element
    matches the corresponding ladder slot — either a scalar prefix part
    or a value inside the last range). When `user_from`/`user_to` is
    given, the slot immediately after `user_prefix` must overlap
    `[user_from, user_to]`.
    """
    prefix_parts, from_v, to_v = parsed
    if len(user_prefix) > len(prefix_parts) + 1:
        return False
    for i, u in enumerate(user_prefix):
        if i < len(prefix_parts):
            if prefix_parts[i] != u:
                return False
        else:
            if not (from_v <= u <= to_v):
                return False
    if user_from is None and user_to is None:
        return True
    f = user_from if user_from is not None else -10**9
    t = user_to if user_to is not None else 10**9
    target_idx = len(user_prefix)
    if target_idx == len(prefix_parts):
        return not (to_v < f or from_v > t)
    if target_idx < len(prefix_parts):
        v = prefix_parts[target_idx]
        return f <= v <= t
    return False


def parse_user_prefix(ref_prefix: str | None) -> list[int] | None:
    """Convert the user-facing dot-string into a list of ints.

    Returns `[]` when the prefix is None/empty (the "any prefix" case
    used for ИШО). Returns `None` on parse failure so the caller can
    short-circuit to an empty result.
    """
    if not ref_prefix:
        return []
    try:
        return [int(p) for p in ref_prefix.split(".") if p]
    except ValueError:
        return None
