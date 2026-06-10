-- Revert 0037: recreate the kind-only lecture HNSW index (the 0035 shape).
-- Heavy: rebuilds the ~320k-vector graph. Only needed if reintroducing the
-- cross-language lecture fallback.

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
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops) '
            'WHERE kind = ''track_transcript''', tbl || '_hnsw_lec', tbl);
    END LOOP;
END $$;
