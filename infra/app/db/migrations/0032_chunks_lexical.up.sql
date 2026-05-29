-- Lexical (full-text + trigram) indexes on `chunks` for HYBRID retrieval.
-- Dense ANN (text-embedding-3-small) is blind to three classes the corpus
-- is full of: canonical addresses ("БГ 2.13" — numbers don't embed),
-- Sanskrit transliteration ("linux-client-kṣema"), and short verses that under-score
-- on cosine. These indexes give the fanout a second, non-cosine recall lane
-- (see research/corpus_fanout._lexical) fused into the candidate pool via RRF.
--
-- WARNING — operator note (lighter than 0030):
--   GIN index builds hold a SHARE lock that blocks WRITES (the indexer) but
--   NOT reads (chat). Chat queries survive the build; only pause the indexer:
--     docker compose up migrator        # chat can stay running
--   Build is minutes (GIN on text), not the tens-of-minutes of an HNSW build.
--
-- All indexes are EXPRESSION indexes over the existing `text` / address
-- columns — NO new columns are added. The lexical SQL MUST use the identical
-- 2-arg `to_tsvector('<config>', text)` expression or the planner skips the
-- index. The 2-arg form is IMMUTABLE (indexable); the 1-arg form is not.

-- Fail fast on lock contention rather than blocking forever.
SET lock_timeout = '30s';
-- GIN build working memory (default 64 MB is small for 461k text rows).
SET maintenance_work_mem = '1GB';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Addresses → trigram GIN (partial: library rows only) ───────────────────
-- Matches "БГ 2.13" / "BG 2.13" / "ШБ 1.1.1" robustly (incl. ru/en prefix and
-- minor typos) via similarity(). Partial WHERE source_id IS NOT NULL mirrors
-- chunks_lib_addr (0010) — transcripts have no source_id and no address.
CREATE INDEX IF NOT EXISTS chunks_addr_trgm
    ON chunks USING gin (
        (coalesce(addr_label, '') || ' ' ||
         coalesce(source_id, '')  || ' ' ||
         coalesce(tokens, '')) gin_trgm_ops
    )
    WHERE source_id IS NOT NULL;

-- ── Content → two tsvector GIN indexes (Russian morphology + exact/translit) ─
-- `russian`: Snowball stemming + stopwords → "душе"/"души"/"душа" match.
CREATE INDEX IF NOT EXISTS chunks_tsv_russian
    ON chunks USING gin (to_tsvector('russian', text));
-- `simple`: no stemming → preserves Sanskrit transliteration + Latin/English
-- tokens the Russian stemmer would mangle.
CREATE INDEX IF NOT EXISTS chunks_tsv_simple
    ON chunks USING gin (to_tsvector('simple', text));
