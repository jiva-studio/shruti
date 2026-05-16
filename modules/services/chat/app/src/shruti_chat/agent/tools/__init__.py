"""Tool registry for the agent loop.

Each tool: declared via `TOOL_SCHEMAS` (JSON-Schema for the LLM) +
`TOOLS` (Python async callable keyed by name). LLM picks the tool;
loop dispatches by name with parsed args.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from shruti_chat.agent.tools import list_tracks as _list_tracks
from shruti_chat.agent.tools import resolve as _resolve
from shruti_chat.agent.tools import search as _search
from shruti_chat.agent.tools import tracks as _tracks

ToolFn = Callable[..., Awaitable[Any]]

TOOLS: dict[str, ToolFn] = {
    "search_transcripts": _search.search_transcripts,
    "list_tracks": _list_tracks.list_tracks,
    "resolve_author": _resolve.resolve_author,
    "resolve_source": _resolve.resolve_source,
    "resolve_location": _resolve.resolve_location,
    "resolve_tag": _resolve.resolve_tag,
    "get_track": _tracks.get_track,
}


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
                "passed via tag_ids (e.g. ['tag_morning_walk'])."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "author_id": {"type": "string"},
                    "source_id": {"type": "string"},
                    "location_id": {"type": "string"},
                    "tag_ids": {"type": "array", "items": {"type": "string"}},
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
]
