-- Reverse of 0023_outbox.up.sql.
-- Drops the auth.users trigger first so the function can be removed; the
-- table + sequence then go with the schema. We only drop the schema if it
-- still owns nothing else (RESTRICT) — a future migration could have added
-- more app.* objects, and forcing CASCADE here would silently take them out.

DROP TRIGGER IF EXISTS trg_emit_user_deleted ON auth.users;
DROP FUNCTION IF EXISTS app.emit_user_deleted();
DROP INDEX IF EXISTS app.outbox_unprocessed_idx;
DROP TABLE IF EXISTS app.outbox;
DROP SCHEMA IF EXISTS app RESTRICT;
