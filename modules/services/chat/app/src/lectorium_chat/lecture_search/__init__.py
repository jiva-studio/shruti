"""Multi-provider external-lecture search.

The `add-to-library` intent needs to find a lecture the user is describing
(a YouTube link, a title, "the 1975 Bhagavad-gita class in Bombay") among
external sources — the corpus index does NOT know about material the user
hasn't imported yet. This package builds that capability from scratch:

- `models.Candidate` — the normalized result shape every provider returns.
- `port.LectureSearchProvider` — the port each source adapter implements.
- `resolver.LectureSearchResolver` — ordered fallback across providers with
  a per-provider timeout, a per-provider circuit breaker, and quota-aware
  ordering (a provider that recently signalled quota exhaustion is tried
  last).
- `providers/` — the concrete adapters. YouTube Data API v3 is a REAL
  adapter (free, thumbnails); yt-dlp / SerpApi / DataForSEO are structured
  but stubbed where a key / binary isn't present (they degrade to "no
  results" rather than crash).

No provider is a hard dependency: a missing key / unreachable host / import
error makes that provider inert and the resolver falls through to the next.
"""

from __future__ import annotations

from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.lecture_search.port import LectureSearchProvider
from lectorium_chat.lecture_search.resolver import LectureSearchResolver

__all__ = ["Candidate", "LectureSearchProvider", "LectureSearchResolver"]
