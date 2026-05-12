-- Lectorium MCP lake registry — schema v2.
-- Adds per-file language so transcribe/review/commit can pick the right
-- variant without re-parsing the path or waiting on the metadata stage.

ALTER TABLE files ADD COLUMN language TEXT NOT NULL DEFAULT '';

-- Backfill from the dedup-tool's canonical layout: outbox/sorted/<lang>/...
UPDATE files SET language = 'ru'
 WHERE language = '' AND path LIKE '%/outbox/sorted/ru/%';
UPDATE files SET language = 'en'
 WHERE language = '' AND path LIKE '%/outbox/sorted/en/%';

INSERT OR IGNORE INTO schema_version (version) VALUES (2);
