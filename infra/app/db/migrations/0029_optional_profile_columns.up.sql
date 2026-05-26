-- Wave 3 / PR-1.5e: relax NOT NULL on auth.identities.email_verified.
--
-- email_verified was created NOT NULL DEFAULT false in 0001. With the
-- ProfilePolicy (services/auth/config/config.yaml), a region running
-- PROFILE=ru disables email collection — and "verified" has no meaning
-- without an email. PR-1.5b leaves the column NULL on those rows.
--
-- No new columns are added. The earlier draft added locale / device_id
-- / last_seen_at / phone columns to auth.users on speculation — none
-- of them are read or written by any current code (device_id is
-- already stored on auth.refresh_tokens; last_seen_at can be derived
-- from refresh_tokens.created_at when the Wave 8 TTL cron lands).
-- Adding unused columns just to "reserve PII slots" was the wrong
-- shape — drop until a real consumer exists.

ALTER TABLE auth.identities ALTER COLUMN email_verified DROP NOT NULL;
