-- Standard PostgreSQL full-text search indexes for Russian morphology and exact/translit tokens (simple).
--
-- Replaces custom functional index from 0013 with native PostgreSQL expression GIN indexes,
-- matching the canonical pattern in infra/app/db/migrations/0032_chunks_lexical.up.sql.

SET maintenance_work_mem = '512MB';

-- Drop obsolete functional indexes from 0004_search.sql and 0013_chunk_tsv_by_script.sql
DROP INDEX IF EXISTS discovery.chunks_fts_idx;
DROP INDEX IF EXISTS discovery.chunks_tsv_idx;

-- Clean up unused column if created by previous test migrations
ALTER TABLE discovery.chunks DROP COLUMN IF EXISTS tsv;

-- Standard expression GIN indexes
CREATE INDEX IF NOT EXISTS chunks_tsv_russian ON discovery.chunks USING gin (to_tsvector('russian', text));
CREATE INDEX IF NOT EXISTS chunks_tsv_english ON discovery.chunks USING gin (to_tsvector('english', text));
CREATE INDEX IF NOT EXISTS chunks_tsv_simple ON discovery.chunks USING gin (to_tsvector('simple', text));

-- Drop obsolete PL/pgSQL helper functions from 0013
DROP FUNCTION IF EXISTS discovery.chunk_tsv(text);
DROP FUNCTION IF EXISTS discovery.words_tsquery(text);
