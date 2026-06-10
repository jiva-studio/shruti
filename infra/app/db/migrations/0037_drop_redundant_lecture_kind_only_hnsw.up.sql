-- Drop the now-redundant kind-only lecture HNSW index.
--
-- WHY ───────────────────────────────────────────────────────────────────
-- Migration 0036 added per-(kind,lang) composite HNSW indexes for the
-- lecture lane (`_hnsw_lec_en`, `_hnsw_lec_ru`). Together with dropping the
-- cross-language fallback in the retrieval code (chunks are cited to users
-- verbatim, so an English clip is useless to a Russian user — we search one
-- language only), every lecture ANN query now carries a concrete lang and
-- is served by a composite. The kind-only `_hnsw_lec` (`WHERE
-- kind='track_transcript'`) became dead weight: it indexes the same ~320k
-- vectors again (~2.5 GB on d1536), doubling the lecture index footprint and
-- evicting the verse/library indexes from page cache on the 8 GB box.
--
-- All track_transcript chunks are en or ru (no NULL lang, no other langs),
-- so the composites give 100% coverage; nothing falls back to kind-only.
--
-- Cheap + fast: dropping an index is metadata-only (no rebuild). Reclaims
-- ~2.5 GB, relieving the cache pressure that made the library lanes cold.

SET lock_timeout = '30s';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);
        EXECUTE format('DROP INDEX IF EXISTS %I', tbl || '_hnsw_lec');
    END LOOP;
END $$;
