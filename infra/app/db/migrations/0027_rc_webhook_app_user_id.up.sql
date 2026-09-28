-- Capture rc_app_user_id on the webhook row at receive time.
--
-- The reconciliation cron's orphan sweep re-fetches unprocessed rows
-- older than 7 days and tries one last REST hit before stamping them
-- processed with error='orphaned_no_link'. The REST call needs the
-- rc_app_user_id; storing it on the row makes the sweep a pure
-- DB-driven loop with no need to keep the original payload.
--
-- Nullable on purpose: rows written before this column existed carry
-- NULL and the sweep skips them (their RC retry budget is exhausted and
-- there is nothing actionable left).

ALTER TABLE auth.rc_webhook_events
  ADD COLUMN app_user_id TEXT;
