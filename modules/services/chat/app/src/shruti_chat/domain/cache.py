"""Cache key composition and the TTLs memoised calls are stored for."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel

_KEY_PREFIX = "lc:v1"

# TTL constants (seconds)
TTL_7D = 7 * 24 * 3600
TTL_14D = 14 * 24 * 3600
TTL_30D = 30 * 24 * 3600
TTL_24H = 24 * 3600
TTL_6H = 6 * 3600


def _serialize_for_key(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    if isinstance(value, dict):
        return {k: _serialize_for_key(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_serialize_for_key(v) for v in value]
    return value


def make_key(ns: str, key_parts: Any, version: str) -> str:
    """Compose the canonical key `lc:v1:{ns}:{ver}:{hash}`."""
    canon = json.dumps(_serialize_for_key(key_parts), ensure_ascii=False, sort_keys=True)
    digest = hashlib.blake2b(canon.encode("utf-8"), digest_size=12).hexdigest()
    return f"{_KEY_PREFIX}:{ns}:{version}:{digest}"
