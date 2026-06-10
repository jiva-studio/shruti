-- Revert 0032: drop the per-kind partial HNSW indexes and the
-- denormalized kind/lang columns, restoring the single full HNSW index
-- per dim table (the 0030 shape).

SET lock_timeout = '30s';
SET maintenance_work_mem = '2GB';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);

        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw_lec');
        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw_verse');
        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw_lib');

        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS kind', tbl);
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS lang', tbl);

        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops)',
            tbl || '_hnsw', tbl);
    END LOOP;
END $$;
