"""Normalize the incoming HTTP event into a typed request.

AWS HTTP API and Yandex API Gateway both wrap the JSON body in `event["body"]`
(possibly base64-encoded). Direct `serverless invoke` passes the dict as-is.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CutRequest:
    source_key: str
    start_ms: int
    end_ms: int
    excerpt_id: str | None


def parse_request(event: Any) -> CutRequest:
    payload = _extract_payload(event)

    try:
        source_key = str(payload["source_key"])
        start_ms = int(payload["start_ms"])
        end_ms = int(payload["end_ms"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid payload: {exc}") from exc

    if start_ms < 0 or end_ms <= start_ms:
        raise ValueError("end_ms must be greater than start_ms; both must be non-negative")
    if (end_ms - start_ms) > 10 * 60 * 1000:
        raise ValueError("excerpt longer than 10 minutes is not supported")

    excerpt_id = payload.get("excerpt_id")
    if excerpt_id is not None and not _is_safe_id(str(excerpt_id)):
        raise ValueError("excerpt_id must be alphanumeric / dash / underscore")

    return CutRequest(
        source_key=source_key,
        start_ms=start_ms,
        end_ms=end_ms,
        excerpt_id=str(excerpt_id) if excerpt_id else None,
    )


def _extract_payload(event: Any) -> dict:
    if isinstance(event, dict) and "body" in event:
        body = event["body"]
        if event.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8")
        if isinstance(body, str):
            return json.loads(body)
        if isinstance(body, dict):
            return body
    if isinstance(event, dict):
        return event
    raise ValueError("unsupported event shape")


def _is_safe_id(value: str) -> bool:
    return bool(value) and all(c.isalnum() or c in "-_" for c in value) and len(value) <= 64
