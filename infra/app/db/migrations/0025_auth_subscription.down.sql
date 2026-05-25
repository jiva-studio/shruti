DROP INDEX IF EXISTS auth.rc_webhook_events_unprocessed_idx;
DROP TABLE IF EXISTS auth.rc_webhook_events;

DROP INDEX IF EXISTS auth.users_rc_app_user_id_idx;
ALTER TABLE auth.users
  DROP COLUMN IF EXISTS rc_app_user_id,
  DROP COLUMN IF EXISTS tier_updated_at,
  DROP COLUMN IF EXISTS tier_expires_at,
  DROP COLUMN IF EXISTS tier;
