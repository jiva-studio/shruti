-- Materialize tsvector on discovery.chunks for fast ranking without on-the-fly text parsing.
--
-- Computing `discovery.chunk_tsv(text)` during ts_rank evaluation forced Postgres to scan
-- long text from heap and re-stem thousands of candidate chunks on every search, causing
-- multi-second query delays and disk sorting spills. Storing `tsv` allows index-accelerated
-- filtering and top-N heapsort in memory.

ALTER TABLE discovery.chunks
    ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (discovery.chunk_tsv(text)) STORED;

-- Drop obsolete index from 0004_search.sql that used 'simple' configuration
DROP INDEX IF EXISTS discovery.chunks_fts_idx;

-- Replace functional expression index with direct column index
DROP INDEX IF EXISTS discovery.chunks_tsv_idx;
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON discovery.chunks USING gin (tsv);
