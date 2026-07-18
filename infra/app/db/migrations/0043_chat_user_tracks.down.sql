-- Revert 0043: drop the per-dim `kind='user_track'` partial HNSW indexes.

SET lock_timeout = '30s';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);
        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw_usr');
    END LOOP;
END $$;
