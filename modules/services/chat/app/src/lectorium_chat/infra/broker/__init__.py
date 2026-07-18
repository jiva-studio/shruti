"""Ingest-request broker publisher.

The `add-to-library` flow hands a chosen external lecture off to the ingest
worker (#1224) by publishing to a broker stream. This package defines the
small publisher port and two implementations:

- `RedisStreamsIngestPublisher` — XADDs onto the configured Redis Stream.
- `NoopIngestPublisher` — logs + no-ops when no broker is configured (the
  #1224 broker may not exist yet), so the feature degrades instead of
  crashing.
"""

from __future__ import annotations

from lectorium_chat.infra.broker.publisher import (
    IngestRequestPublisher,
    NoopIngestPublisher,
    RedisStreamsIngestPublisher,
    build_ingest_publisher,
)

__all__ = [
    "IngestRequestPublisher",
    "NoopIngestPublisher",
    "RedisStreamsIngestPublisher",
    "build_ingest_publisher",
]
