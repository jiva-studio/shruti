"""Detect which content kind(s) the user explicitly asked for, so retrieval
can rank them higher (`fanout_search_with_boost(boost_kinds=…)`).

Two sources, unioned:
  1. `router_args["content_types"]` — the LLM router sometimes extracts this
     (observed: a verse query returned `content_types: ["verse","commentary"]`).
  2. A deterministic keyword backstop over the raw query — so it works even
     when the LLM omits it, and without a Langfuse prompt deploy.

Conservative on purpose: only fire on unambiguous cue words. An empty result
means "no explicit kind" → no boost (normal ranking).
"""

from __future__ import annotations

import re

# Corpus chunk kinds (see agent/tools/chunks_search._LIBRARY_KINDS + "lecture").
_CORPUS_KINDS = frozenset(
    {"verse", "commentary", "prose_chapter", "letter", "media", "lecture"}
)

# The router is told to say "transcript" for a lecture, and does — production
# extracted `["verse","commentary","prose_chapter","transcript"]` on a live turn.
# Only "transcript" was silently discarded, so the ONE kind the person spelled
# out for us was the one kind that got no boost. The prompt now says "lecture";
# the alias stays because the prompt is served from Langfuse and an older copy
# of it must not quietly lose the boost again.
_KIND_ALIASES = {"transcript": "lecture", "track": "lecture"}


def _canonical(kind: object) -> str | None:
    if not isinstance(kind, str):
        return None
    k = _KIND_ALIASES.get(kind.strip(), kind.strip())
    return k if k in _CORPUS_KINDS else None

# Unambiguous cue words → kind. ru + en; kept tight to avoid false boosts.
_KIND_KEYWORDS: dict[str, tuple[str, ...]] = {
    "media": (r"виде[оа]", r"клип", r"ролик", r"\bvideo", r"\bclip", r"footage"),
    "letter": (r"письм", r"\bletter"),
    "verse": (r"шлок", r"\bстих", r"\bverse\b", r"shloka", r"śloka"),
    "commentary": (r"пурпорт", r"коммент", r"purport", r"commentar"),
}


def boost_kinds_from(
    query: str, router_args: dict, *, author_asked: bool = False,
) -> frozenset[str]:
    """Union of router-extracted `content_types` and keyword hits, restricted
    to known corpus kinds. Empty frozenset when nothing explicit is asked.

    `author_asked` boosts LECTURES. Asking what a named teacher said makes their
    own words the subject, and without this the answer is built from whatever sits
    nearest in the corpus: production retrieved 59 fragments of the very lecturer
    asked for, kept six in the top, and then planned the answer from ten purports
    and two verses — a reply about him with nothing of his in it.
    """
    kinds: set[str] = set()
    if author_asked:
        kinds.add("lecture")

    ct = (router_args or {}).get("content_types")
    if isinstance(ct, list):
        kinds |= {c for c in (_canonical(k) for k in ct) if c}
    else:
        one = _canonical(ct)
        if one:
            kinds.add(one)

    low = (query or "").lower()
    for kind, patterns in _KIND_KEYWORDS.items():
        if any(re.search(p, low) for p in patterns):
            kinds.add(kind)

    return frozenset(kinds)
