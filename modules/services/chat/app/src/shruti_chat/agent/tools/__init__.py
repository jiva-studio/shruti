"""Tool registry for the agent loop.

Each tool: declared via `TOOL_SCHEMAS` (JSON-Schema for the LLM) +
`TOOLS` (Python async callable keyed by name). LLM picks the tool;
loop dispatches by name with parsed args.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from shruti_chat.agent.tools import actions as _actions
from shruti_chat.agent.tools import list_tracks as _list_tracks
from shruti_chat.agent.tools import outline as _outline
from shruti_chat.agent.tools import personalize as _personalize
from shruti_chat.agent.tools import resolve as _resolve
from shruti_chat.agent.tools import search as _search
from shruti_chat.agent.tools import similar as _similar
from shruti_chat.agent.tools import tracks as _tracks
from shruti_chat.agent.tools import window as _window

ToolFn = Callable[..., Awaitable[Any]]

TOOLS: dict[str, ToolFn] = {
    # Existing read-only tools
    "search_transcripts": _search.search_transcripts,
    "list_tracks": _list_tracks.list_tracks,
    "resolve_author": _resolve.resolve_author,
    "resolve_source": _resolve.resolve_source,
    "resolve_location": _resolve.resolve_location,
    "resolve_tag": _resolve.resolve_tag,
    "get_track": _tracks.get_track,
    # New corpus tools
    "get_track_outline": _outline.get_track_outline,
    "get_transcript_window": _window.get_transcript_window,
    "find_similar_chunks": _similar.find_similar_chunks,
    # Personalization (need user_context bound via build_personalized_tools)
    "continue_listening": _personalize.continue_listening,
    "recommend_next": _personalize.recommend_next,
    "search_my_history": _personalize.search_my_history,
    "search_my_notes": _personalize.search_my_notes,
    # Action proposals
    "propose_playlist": _actions.propose_playlist,
    "propose_save_note": _actions.propose_save_note,
}


_PERSONALIZED = {
    "continue_listening",
    "recommend_next",
    "search_my_history",
    "search_my_notes",
}


def build_personalized_tools(base: dict[str, ToolFn], user_context: Any) -> dict[str, ToolFn]:
    """Bind `user_context` into personalize tools via closure.

    Stateless tools (search_transcripts, get_track, ...) pass through unchanged.
    Stateful tools (continue_listening, recommend_next, search_my_history,
    search_my_notes) receive user_context implicitly; the LLM-visible
    JSON-Schema in TOOL_SCHEMAS doesn't expose `user_context`.
    """
    out = dict(base)
    for name in _PERSONALIZED:
        fn = base.get(name)
        if fn is None:
            continue

        def _make(_fn: ToolFn) -> ToolFn:
            async def _wrapped(**kwargs: Any) -> Any:
                # Reject any caller-supplied user_context to prevent
                # the LLM from injecting a fake context via JSON.
                kwargs.pop("user_context", None)
                return await _fn(user_context=user_context, **kwargs)
            return _wrapped

        out[name] = _make(fn)
    return out


TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_transcripts",
            "description": (
                "Semantic search over lecture transcripts. Use for "
                "conceptual / thematic questions: 'what did he say about X', "
                "'where does he explain Y'. Returns chunks with timestamps "
                "you must cite via [cite:track_id@start_ms-end_ms]."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "author_id": {"type": "string"},
                    "source_id": {"type": "string"},
                    "location_id": {"type": "string"},
                    "tag_ids": {"type": "array", "items": {"type": "string"}},
                    "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                    "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                    "top_k": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_tracks",
            "description": (
                "Deterministic metadata filter over the lecture catalog. Use "
                "for list-style queries: 'lectures by X from Y in period Z'. "
                "Returns tracks for [card:track_id] markers in your reply. "
                "Kind (morning walk / conversation / lecture / ...) is "
                "passed via tag_ids (e.g. ['tag_morning_walk']).\n\n"
                "**`title_query` is the way to find a lecture by name.** "
                "When the user says «найди лекцию «X»» / «перескажи лекцию X», "
                "pass the bare phrase (no quotes) as `title_query` — it runs "
                "FTS against the actual lecture titles (with prefix matching, "
                "accent-insensitive). search_transcripts searches the SPOKEN "
                "TEXT, not titles — don't use it for 'find lecture named X'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "author_id": {"type": "string"},
                    "source_id": {"type": "string"},
                    "location_id": {"type": "string"},
                    "tag_ids": {"type": "array", "items": {"type": "string"}},
                    "title_query": {
                        "type": "string",
                        "description": "Fuzzy FTS query over track titles. Use for «найди лекцию X».",
                    },
                    "date_from": {"type": "string"},
                    "date_to": {"type": "string"},
                    "lang": {"type": "string", "enum": ["ru", "en"], "default": "ru"},
                    "limit": {"type": "integer", "default": 20},
                    "offset": {"type": "integer", "default": 0},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_author",
            "description": "Translate a human author name into author_id. Call BEFORE list_tracks/search_transcripts when filtering by author.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "lang": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_source",
            "description": "Translate a book/source name (e.g. 'Bhagavad-gita', 'Шримад-Бхагаватам') into source_id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "lang": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_location",
            "description": "Translate a location name (city, place) into location_id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "lang": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_tag",
            "description": (
                "Translate a tag name into tag_id. Includes kind-tags: "
                "'tag_morning_walk', 'tag_conversation', 'tag_lecture', "
                "'tag_initiation', 'tag_address', 'tag_festival', "
                "'tag_interview', 'tag_press_conf', 'tag_bhajan', "
                "'tag_vyasa_puja', 'tag_wedding', 'tag_other'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "lang": {"type": "string"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_track",
            "description": "Fetch full metadata for one track by id. Use to enrich a citation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {"type": "string"},
                    "lang": {"type": "string", "default": "ru"},
                },
                "required": ["track_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_track_outline",
            "description": (
                "Generate (or fetch cached) outline for a track: 5-8 chapter-like "
                "items with timecodes (start_ms) and titles. Use when the user asks "
                "for a summary, the contents of a lecture, or 'recap what I just "
                "listened to'. After calling, embed the marker '[outline:<track_id>]' "
                "in your reply where the outline card should render — the client "
                "mounts an interactive list at that position."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {"type": "string"},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                },
                "required": ["track_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_transcript_window",
            "description": (
                "Fetch transcript chunks within ±window_seconds of a given timecode "
                "to enrich context around an existing citation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {"type": "string"},
                    "around_ms": {"type": "integer"},
                    "window_seconds": {"type": "integer", "default": 60},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                },
                "required": ["track_id", "around_ms"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_similar_chunks",
            "description": (
                "Find passages in OTHER tracks semantically similar to a given "
                "(track_id, start_ms-end_ms) fragment. Use for 'where else did he "
                "say something similar'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {"type": "string"},
                    "start_ms": {"type": "integer"},
                    "end_ms": {"type": "integer"},
                    "top_k": {"type": "integer", "default": 6},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                },
                "required": ["track_id", "start_ms", "end_ms"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "continue_listening",
            "description": (
                "Return the user's in-progress tracks (top 3, recency-ordered). "
                "Use when user asks 'where did I stop', 'continue listening'."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recommend_next",
            "description": (
                "Recommend tracks similar to what the user recently listened to. "
                "Pass `based_on_track_id` to anchor on one specific track; "
                "otherwise uses centroid of last 5 recent tracks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "based_on_track_id": {"type": "string"},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                    "top_k": {"type": "integer", "default": 6},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_my_history",
            "description": (
                "Semantic search restricted to the user's recent_tracks. Use for "
                "'I heard something about X recently, find it'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "lang": {"type": "string", "enum": ["ru", "en"]},
                    "top_k": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_my_notes",
            "description": (
                "Semantic ranking over notes the user has saved. Use for 'what "
                "did I write about X'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer", "default": 8},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_playlist",
            "description": (
                "Propose creating a playlist for the user — DOES NOT create it. "
                "The client will render a card with a confirm button. After "
                "calling, embed the returned marker (e.g. '[action:create-playlist|id=...]') "
                "inline in your reply at the position the card should render. "
                "Never claim the playlist exists — say 'предлагаю собрать плейлист'. "
                "Pick at most 20 track_ids (server hard-caps at 30). "
                "DO NOT also emit `[card:...]` for the same tracks — the action card shows them itself."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short playlist name (3-6 words)"},
                    "track_ids": {"type": "array", "items": {"type": "string"}},
                    "rationale": {"type": "string"},
                },
                "required": ["name", "track_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_save_note",
            "description": (
                "Propose saving a quote as a user note — DOES NOT save it. "
                "The client will render a card with a confirm button. Embed "
                "the returned marker inline. Never claim the note is saved."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {"type": "string"},
                    "start_ms": {"type": "integer"},
                    "end_ms": {"type": "integer"},
                    "text": {"type": "string"},
                    "suggested_caption": {"type": "string"},
                },
                "required": ["track_id", "start_ms", "end_ms", "text"],
            },
        },
    },
]
