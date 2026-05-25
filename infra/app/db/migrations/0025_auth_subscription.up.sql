-- Server-side subscription state mirrored from RevenueCat.
--
-- `tier` is the only field the rate-limiter actually consumes (via the
-- JWT claim added in the same release); `tier_expires_at` and
-- `tier_updated_at` are bookkeeping for the reconciliation cron and for
-- operators reading the row. `rc_app_user_id` is RevenueCat's stable id
-- for this customer — set by `Purchases.logIn(<sub>)` on the client and
-- captured by the webhook handler on first event delivery.

ALTER TABLE auth.users
  ADD COLUMN tier              TEXT        NOT NULL DEFAULT 'free',
  ADD COLUMN tier_expires_at   TIMESTAMPTZ,
  ADD COLUMN tier_updated_at   TIMESTAMPTZ,
  ADD COLUMN rc_app_user_id    TEXT;

CREATE UNIQUE INDEX users_rc_app_user_id_idx
  ON auth.users(rc_app_user_id) WHERE rc_app_user_id IS NOT NULL;

-- Webhook delivery log. The webhook handler INSERTs on first delivery
-- and UPDATEs `processed_at` after the REST refetch + user UPDATE land
-- in a single transaction. A row with `processed_at IS NULL` means
-- either (a) processing is in flight, (b) the previous attempt's
-- REST refetch failed (see `error`), or (c) the handler crashed before
-- completing. RevenueCat will retry on its own for the first ~80 min;
-- after that the reconciliation cron (Phase 8) replays unprocessed
-- rows older than 15 min.
CREATE TABLE auth.rc_webhook_events (
  event_id     TEXT        PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error        TEXT
);

CREATE INDEX rc_webhook_events_unprocessed_idx
  ON auth.rc_webhook_events(received_at) WHERE processed_at IS NULL;
