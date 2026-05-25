-- Outbox dedup: prevent duplicate emits when the producer can be retried.
--
-- The RC webhook handler INSERTs into app.outbox inside ApplyRCSubscriberState.
-- If a duplicate webhook delivery slips past auth.rc_webhook_events idempotency
-- (Tier 1.2 closes most of that, but a torn commit between the existence check
-- and the INSERT can still produce two outbox rows for one RC event_id), the
-- cleanup-worker will process `subscription.changed` twice, doubling any
-- emitted metrics and re-running side-effects that may be costly to repeat.
--
-- This index gives the producer a hard guarantee: pair (event_type, source_event_id)
-- is globally unique when source_event_id is non-NULL. Producers add
-- `ON CONFLICT (event_type, source_event_id) WHERE source_event_id IS NOT NULL
-- DO NOTHING` to their INSERT and a duplicate becomes a silent no-op.
--
-- source_event_id is NULLABLE on purpose:
--   - Events that don't need dedup (e.g. user.deleted from the AFTER DELETE
--     trigger, where the trigger only fires once per row by Postgres
--     contract) carry NULL and bypass the constraint entirely.
--   - The partial index (WHERE source_event_id IS NOT NULL) keeps the index
--     small and avoids wedging unrelated events on a shared NULL slot.

ALTER TABLE app.outbox ADD COLUMN source_event_id TEXT;

CREATE UNIQUE INDEX outbox_dedup_idx
  ON app.outbox(event_type, source_event_id)
  WHERE source_event_id IS NOT NULL;
