"""Broker adapters for the chat service.

Redis-Streams consumers that keep the chat corpus / RAG index in sync with the
ingest + publish pipelines. They are imported by module path (e.g.
`shruti_chat.infra.broker.track_events_consumer`), so nothing is re-exported
here. (The former ingest-request publisher is gone — the client now submits to
the orchestrator ingest API directly; chat never ingests.)
"""

from __future__ import annotations
