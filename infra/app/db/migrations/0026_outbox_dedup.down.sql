-- Reverse of 0026_outbox_dedup.up.sql. Drop the partial unique index first
-- (it would otherwise pin the column), then the column itself.

DROP INDEX IF EXISTS app.outbox_dedup_idx;
ALTER TABLE app.outbox DROP COLUMN IF EXISTS source_event_id;
