-- Revert 0036: drop the per-language lecture partial HNSW indexes.
-- The kind-only `_hnsw_lec` (migration 0035) remains and continues to
-- serve lecture queries (with the lang post-filter tail).

SET lock_timeout = '30s';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    lng   text;
    langs text[] := ARRAY['en', 'ru'];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);
        FOREACH lng IN ARRAY langs LOOP
            EXECUTE format('DROP INDEX IF EXISTS %I', format('%s_hnsw_lec_%s', tbl, lng));
        END LOOP;
    END LOOP;
END $$;
