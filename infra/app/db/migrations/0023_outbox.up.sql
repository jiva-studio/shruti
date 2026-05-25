-- Generic transactional outbox for cross-service domain events.
--
-- Producers (e.g. the auth service) INSERT a row inside their own business
-- transaction; a separate cleanup-worker LISTENs on the `outbox` channel,
-- claims rows with SELECT ... FOR UPDATE SKIP LOCKED, runs the side-effect
-- (Langfuse purge, S3 prefix delete, etc.), and stamps `processed_at`.
--
-- Producers never need to know about downstream consumers — they speak the
-- single language of (event_type, aggregate_id, payload). The first user is
-- `user.deleted` emitted by an AFTER DELETE trigger on auth.users (below).
--
-- File numbering note: README's "shared" range is 0020+. This file is a
-- cross-service object (outbox is produced by auth, consumed by the worker),
-- so it lands in the shared range rather than the auth-specific 0001_auth_*
-- or chat-specific 0010..0019 ranges.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.outbox (
    id           bigserial PRIMARY KEY,
    -- Dotted event name, e.g. 'user.deleted'. Consumers filter on this.
    event_type   text NOT NULL,
    -- Stringified id of the aggregate the event is about. For 'user.deleted'
    -- this is the auth.users.id (uuid cast to text); generic on purpose so
    -- future events can carry track/pack/whatever ids without a schema change.
    aggregate_id text NOT NULL,
    -- Optional event-specific data. Empty object means "everything you need
    -- is in event_type + aggregate_id" — the user.deleted case.
    payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL = unprocessed; set by the worker on success. We keep processed
    -- rows around so a metrics scrape / audit can replay history; a future
    -- migration may add a TTL job.
    processed_at timestamptz
);

-- Partial index so the worker's "next unprocessed row" SELECT stays cheap
-- regardless of how many processed rows accumulate. Order matters: filtering
-- by event_type first lets a per-event worker (if we ever shard) hit the
-- index directly.
CREATE INDEX outbox_unprocessed_idx
    ON app.outbox (event_type, occurred_at)
    WHERE processed_at IS NULL;

-- Trigger function: enqueue + notify on auth.users delete.
--
-- SECURITY DEFINER lets the trigger INSERT into app.outbox even if a future
-- migration locks down per-role INSERT grants — the function runs as its
-- owner (the migration role, which owns the schema). Today every service
-- connects as the single `shruti` role so this is belt-and-suspenders,
-- but it keeps the trigger working if we ever split into per-service roles.
--
-- The NOTIFY payload is the event_type string only, so a LISTENing worker
-- can fast-path-filter without round-tripping to read the row. The row is
-- always fetched afterwards via SELECT ... FOR UPDATE SKIP LOCKED — NOTIFY
-- is just a wake-up signal, not the source of truth.
CREATE OR REPLACE FUNCTION app.emit_user_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
BEGIN
    INSERT INTO app.outbox (event_type, aggregate_id, payload)
    VALUES ('user.deleted', OLD.id::text, '{}'::jsonb);
    PERFORM pg_notify('outbox', 'user.deleted');
    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_emit_user_deleted
    AFTER DELETE ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION app.emit_user_deleted();

-- Grants: every service in this project connects as the single `shruti`
-- role (see infra/app/compose/docker-compose.yml — DATABASE_URL uses one
-- user across auth, chat, share-video, and the upcoming cleanup-worker),
-- and that role owns every schema by virtue of running the migrations.
-- We therefore don't fan out per-role GRANTs here; if a future PR splits
-- into auth-svc / chat-svc / cleanup-worker roles, add the corresponding
-- GRANT INSERT (producer) / GRANT SELECT, UPDATE (consumer) statements
-- next to the role creation in that migration.
