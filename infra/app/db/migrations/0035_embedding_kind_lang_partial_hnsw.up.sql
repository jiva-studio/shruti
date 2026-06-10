-- Denormalize chunk `kind`/`lang` into the per-dim embedding tables and
-- replace the single full HNSW index with per-kind PARTIAL HNSW indexes.
--
-- WHY ───────────────────────────────────────────────────────────────────
-- Every lecture/library ANN search filters by kind (and usually lang), but
-- that filter lives on `chunks` while the HNSW index sits on
-- `chunk_embeddings_d{N}`. The filter is therefore applied AFTER the index
-- via the join, so with `hnsw.iterative_scan=relaxed_order` the search
-- walks thousands of candidates to find K that survive the post-join
-- filter. Measured on prod-scale data: a query whose nearest neighbours
-- aren't the requested kind takes 2.2 s (HNSW returns ~700 candidates,
-- nested-loop-filtered down to 24); on prod this spikes to 5-12 s and is
-- the single largest contributor to the 30-40 s chat turn.
--
-- A PARTIAL HNSW index `WHERE kind='track_transcript'` builds the graph
-- over ONLY that kind, so the search returns K directly — no deep scan,
-- no post-filter. Same probe: 2.2 s → 84 ms (PoC, local 462k-row corpus).
-- `lang` stays a regular column (post-filtered): keeping it out of the
-- index predicate means the planner can use the partial index for the
-- `lang IS NULL` fallback too, and we don't fan out an index per language.
--
-- All ANN queries are kind-filtered to {track_transcript, verse,
-- commentary, prose_chapter, letter}; media/title are never ANN-searched,
-- so the full index is not needed and is dropped.
--
-- OPERATOR ACTION (same as 0030): stop chat before running — the index
-- rebuilds are heavy CPU/RAM and the column backfill would otherwise
-- contend with chat's read queries:
--     docker compose stop chat && docker compose up migrator && docker compose start chat
-- A clean `compose up` handles this via chat's depends_on:migrator.

SET lock_timeout = '30s';
-- HNSW builds need working memory; default 64 MB OOMs / crawls on a
-- 100k+ row × 1536-dim partial.
SET maintenance_work_mem = '2GB';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);

        -- 1. Denormalized filter columns (nullable; backfilled below,
        --    populated on insert by the indexer going forward).
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS kind text', tbl);
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS lang text', tbl);

        -- 2. Drop the full HNSW index BEFORE the backfill so the UPDATE
        --    doesn't churn the index (each touched row would otherwise
        --    re-insert into the HNSW graph — minutes of needless work).
        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw');

        -- 3. Backfill kind/lang from chunks. No-op on the empty legacy
        --    dim tables; only the active dim holds rows.
        EXECUTE format(
            'UPDATE %I e SET kind = c.kind, lang = c.lang '
            'FROM chunks c WHERE c.id = e.chunk_id '
            'AND (e.kind IS NULL OR e.lang IS NULL)', tbl);

        -- 4. Per-kind PARTIAL HNSW indexes matching the query predicates:
        --    lecture lane            → kind = 'track_transcript'
        --    library verse lane      → kind = 'verse'
        --    library commentary lane → kind IN (commentary, prose_chapter, letter)
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops) '
            'WHERE kind = ''track_transcript''', tbl || '_hnsw_lec', tbl);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops) '
            'WHERE kind = ''verse''', tbl || '_hnsw_verse', tbl);
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops) '
            'WHERE kind IN (''commentary'', ''prose_chapter'', ''letter'')',
            tbl || '_hnsw_lib', tbl);
    END LOOP;
END $$;
