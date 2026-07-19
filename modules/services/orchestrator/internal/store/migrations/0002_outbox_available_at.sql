-- Backoff support for the retry re-dispatch.
--
-- A retriable ingest failure re-appends an `ingest.work` row; without a delay
-- the relay XADDs it within a tick and the worker re-runs immediately, so a
-- transient upstream outage (or an open yt-dlp circuit breaker on its cooldown)
-- burns the whole attempt budget in well under a second. `available_at` is a
-- not-before stamp: the relay holds a row until now() >= available_at, so a
-- retry can wait an exponential backoff. Normal rows default to now() and drain
-- immediately, unchanged.

ALTER TABLE orchestrator.outbox
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

-- Replace the drain index so the relay's `published_at IS NULL AND available_at
-- <= now() ORDER BY seq` stays index-only.
DROP INDEX IF EXISTS orchestrator.outbox_unpublished_idx;
CREATE INDEX outbox_drainable_idx
    ON orchestrator.outbox (available_at, seq) WHERE published_at IS NULL;
