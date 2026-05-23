"""Idempotent Langfuse score-config bootstrap.

Wired into the FastAPI lifespan startup. On every boot:

  1. List existing score configs.
  2. For each entry in `SCORE_CONFIGS` whose `name` isn't already
     registered, POST it.

Non-fatal end-to-end: if Langfuse is unreachable, we log a warning and
return. The service keeps running without configs — scores still
ingest, we just lose server-side validation + UI dropdowns.

This is intentionally in-process (no separate `scripts/` directory or
out-of-band Docker job) so that a Langfuse-DB wipe or a new score
added to `score_configs.py` self-heals on the next service restart.
Owns one extra Langfuse round-trip per boot, which is fine.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.score_configs import SCORE_CONFIGS


log = get_logger(__name__)


def bootstrap_score_configs(langfuse: Any | None) -> None:
    """Register every entry in `SCORE_CONFIGS` that doesn't already
    exist on the connected Langfuse instance.

    Sync because the Langfuse Python SDK `score_configs` resource is
    sync; called from the async lifespan via no-arg wrapper. Loop is
    short (~15 entries today) and runs only at boot — no need to bury
    it on a thread.
    """
    if langfuse is None:
        log.info("score_configs_bootstrap_skipped_no_langfuse")
        return

    try:
        existing_resp = langfuse.api.score_configs.get()
    except Exception as exc:  # noqa: BLE001
        log.warning("score_configs_bootstrap_list_failed", error=str(exc))
        return

    existing_names: set[str] = set()
    for entry in getattr(existing_resp, "data", None) or []:
        name = getattr(entry, "name", None)
        if isinstance(name, str):
            existing_names.add(name)

    created = 0
    skipped = 0
    failed = 0
    for spec in SCORE_CONFIGS:
        name = spec.get("name")
        if not isinstance(name, str):
            failed += 1
            continue
        if name in existing_names:
            skipped += 1
            continue
        try:
            langfuse.api.score_configs.create(**spec)
            created += 1
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "score_configs_bootstrap_create_failed",
                name=name,
                error=str(exc),
            )
            failed += 1

    log.info(
        "score_configs_bootstrap_done",
        created=created,
        skipped=skipped,
        failed=failed,
        total=len(SCORE_CONFIGS),
    )
