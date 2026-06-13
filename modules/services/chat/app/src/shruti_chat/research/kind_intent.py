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

# Unambiguous cue words → kind. ru + en; kept tight to avoid false boosts.
_KIND_KEYWORDS: dict[str, tuple[str, ...]] = {
    "media": (r"виде[оа]", r"клип", r"ролик", r"\bvideo", r"\bclip", r"footage"),
    "letter": (r"письм", r"\bletter"),
    "verse": (r"шлок", r"\bстих", r"\bverse\b", r"shloka", r"śloka"),
    "commentary": (r"пурпорт", r"коммент", r"purport", r"commentar"),
}


def boost_kinds_from(query: str, router_args: dict) -> frozenset[str]:
    """Union of router-extracted `content_types` and keyword hits, restricted
    to known corpus kinds. Empty frozenset when nothing explicit is asked."""
    kinds: set[str] = set()

    ct = (router_args or {}).get("content_types")
    if isinstance(ct, list):
        kinds |= {k for k in ct if k in _CORPUS_KINDS}
    elif isinstance(ct, str) and ct in _CORPUS_KINDS:
        kinds.add(ct)

    low = (query or "").lower()
    for kind, patterns in _KIND_KEYWORDS.items():
        if any(re.search(p, low) for p in patterns):
            kinds.add(kind)

    return frozenset(kinds)
