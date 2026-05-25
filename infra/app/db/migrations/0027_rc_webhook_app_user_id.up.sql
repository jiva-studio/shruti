-- Capture rc_app_user_id on the webhook row at receive time.
--
-- Plan 1.3 (orphan sweep): reconciliation cron's Step 3 re-fetches
-- unprocessed rows older than 7 days and tries one last REST hit
-- before stamping them processed with error='orphaned_no_link'. The
-- REST call needs the rc_app_user_id, which was previously read from
-- the JSON payload at apply time and never persisted. Storing it on
-- the row makes the sweep a pure DB-driven loop with no need to keep
-- the original payload.
--
-- Nullable on purpose: legacy rows from before this migration carry
-- NULL, the sweep skips them (their RC retry budget was exhausted long
-- ago and there's nothing actionable left).

ALTER TABLE auth.rc_webhook_events
  ADD COLUMN app_user_id TEXT;
