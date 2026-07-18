-- Private per-user lecture RAG (#1227): a `kind='user_track'` PARTIAL HNSW
-- index on every per-dim embedding table, mirroring the per-kind partial
-- indexes introduced in 0035.
--
-- WHY ───────────────────────────────────────────────────────────────────
-- User-added lectures ("add to my library") are indexed into the SAME
-- `chunks` / `chunk_embeddings_d{N}` tables as the curated corpus, but carry
-- `kind='user_track'` so ACL-scoped retrieval can query them in their own
-- lane WITHOUT ever touching the public `track_transcript` graph. The
-- private lane's ANN query inlines `e.kind = 'user_track'` as a constant (see
-- pg_chunk_repository.search_by_embedding) so the planner matches this
-- partial index — the same technique 0035 uses for the lecture / verse /
-- library lanes. `lang` stays a post-filtered column (out of the predicate)
-- so the one index serves both the lang-scoped and lang-less fallback.
--
-- The isolation guarantee is structural: the public lecture lane filters
-- `e.kind = 'track_transcript'`, so a `user_track` row can never surface in
-- the default corpus search, and vice versa.
--
-- OPERATOR ACTION (same as 0035): the index build is heavy CPU/RAM; run it
-- with chat stopped so the build doesn't contend with read queries:
--     docker compose stop chat && docker compose up migrator && docker compose start chat
-- A clean `compose up` handles this via chat's depends_on:migrator.

SET lock_timeout = '30s';
-- HNSW builds need working memory; the default 64 MB crawls / OOMs on a
-- 1536-dim partial once user tracks accumulate.
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
            'WHERE kind = ''user_track''', tbl || '_hnsw_usr', tbl);
    END LOOP;
END $$;
