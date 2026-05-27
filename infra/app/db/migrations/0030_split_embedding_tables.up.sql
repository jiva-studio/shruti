-- Split per-dim embedding columns into separate physical tables.
-- Original `chunks` and `attribution_embeddings` hardcoded
-- `embedding vector(1536)` (migrations 0010 / 0016) — fixed at the dim
-- of OpenAI text-embedding-3-small. New deployments using a different
-- embed provider (Yandex 256-dim, GigaChat 1024-dim, Gemini 768-dim)
-- can't coexist with that single column.
--
-- WARNING — operator action required BEFORE running this migration:
--   The migration acquires AccessExclusiveLock on `chunks` and
--   `attribution_embeddings` (ALTER TABLE DROP COLUMN) and rebuilds
--   HNSW indexes (heavy CPU + RAM). Stop the chat service first or
--   the ALTER will block indefinitely behind chat's read queries:
--
--     docker compose stop chat
--     docker compose up migrator
--     docker compose start chat
--
--   The chat container's depends_on:migrator means a clean compose
--   up handles this automatically; this note is for hotfix workflows
--   where migrator is invoked while chat is already running.
--
-- Strategy:
--   1. CREATE all per-dim tables IF NOT EXISTS (idempotent on retry)
--   2. INSERT existing 1536-dim data into chunk_embeddings_d1536 /
--      attribution_emb_d1536 (ON CONFLICT DO NOTHING — idempotent)
--   3. DROP old embedding column + its HNSW index
--   4. BUILD HNSW indexes on the per-dim tables (with 2 GB
--      maintenance_work_mem; expect 10-60 min on a 461k-row corpus)
--
-- The active dim is selected at runtime by `EmbeddingTableRouter`
-- (Python side). The indexer writes into the d{N} table matching its
-- embedder; queries JOIN through the same table.

-- Fail fast on lock contention (default would block forever).
SET lock_timeout = '30s';

-- HNSW build needs working memory — default 64 MB is far too small
-- for 461k 1536-dim vectors and would either OOM or take hours.
SET maintenance_work_mem = '2GB';

-- ── chunks per-dim tables ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunk_embeddings_d1536 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(1536) NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_embeddings_d1024 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_embeddings_d768 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(768) NOT NULL
);
CREATE TABLE IF NOT EXISTS chunk_embeddings_d256 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(256) NOT NULL
);

-- Copy existing 1536-dim data only if the source column still exists
-- (skipped on fresh deploys where chunks.embedding never existed, and
-- on retries where data was already copied).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'chunks'
           AND column_name = 'embedding'
    ) THEN
        INSERT INTO chunk_embeddings_d1536 (chunk_id, embedding)
        SELECT id, embedding FROM chunks
        ON CONFLICT (chunk_id) DO NOTHING;
    END IF;
END $$;

-- ── attribution_embeddings per-dim tables ──────────────────────────────
-- The source table has a composite PK (attribution_id, language, text,
-- embed_model). The per-dim tables mirror that PK so the FK CASCADE
-- still flows from `attributions` → `attribution_embeddings` → d{N}.
--
-- The attribution_emb_hnsw index on the source table was partial
-- (WHERE embed_model='openai/text-embedding-3-small'). The per-dim
-- HNSW indices below are unpartial — the table is already partitioned
-- by dim, and embed_model filtering happens in the query WHERE.
CREATE TABLE IF NOT EXISTS attribution_emb_d1536 (
    attribution_id TEXT NOT NULL,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL,
    embed_model    TEXT NOT NULL,
    embedding      vector(1536) NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model),
    FOREIGN KEY (attribution_id, language, text, embed_model)
        REFERENCES attribution_embeddings (attribution_id, language, text, embed_model)
        ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attribution_emb_d1024 (
    attribution_id TEXT NOT NULL,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL,
    embed_model    TEXT NOT NULL,
    embedding      vector(1024) NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model),
    FOREIGN KEY (attribution_id, language, text, embed_model)
        REFERENCES attribution_embeddings (attribution_id, language, text, embed_model)
        ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attribution_emb_d768 (
    attribution_id TEXT NOT NULL,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL,
    embed_model    TEXT NOT NULL,
    embedding      vector(768) NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model),
    FOREIGN KEY (attribution_id, language, text, embed_model)
        REFERENCES attribution_embeddings (attribution_id, language, text, embed_model)
        ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attribution_emb_d256 (
    attribution_id TEXT NOT NULL,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL,
    embed_model    TEXT NOT NULL,
    embedding      vector(256) NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model),
    FOREIGN KEY (attribution_id, language, text, embed_model)
        REFERENCES attribution_embeddings (attribution_id, language, text, embed_model)
        ON DELETE CASCADE
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'attribution_embeddings'
           AND column_name = 'embedding'
    ) THEN
        INSERT INTO attribution_emb_d1536
            (attribution_id, language, text, embed_model, embedding)
        SELECT attribution_id, language, text, embed_model, embedding
          FROM attribution_embeddings
        ON CONFLICT (attribution_id, language, text, embed_model) DO NOTHING;
    END IF;
END $$;

-- ── Drop old single-column embedding + its HNSW index ──────────────────
DROP INDEX IF EXISTS chunks_hnsw;
ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;

DROP INDEX IF EXISTS attribution_emb_hnsw;
ALTER TABLE attribution_embeddings DROP COLUMN IF EXISTS embedding;

-- ── HNSW indexes on per-dim tables ─────────────────────────────────────
-- These are the slowest step. On a 461k-row × 1536-dim table the build
-- takes ~10-60 minutes depending on CPU and memory; expect 2-4 GB RSS
-- on the postgres container during the build (hence the 2 GB
-- maintenance_work_mem set at the top).
--
-- CONCURRENTLY can't be used inside the migration's wrapping
-- transaction. Operators wanting non-blocking rebuild (live reads
-- during build) can DROP the per-dim HNSW index and recreate it
-- CONCURRENTLY manually after the migration finishes — but stopping
-- chat for the migration window is the simpler path and is the one
-- the deploy script wires up (chat depends_on migrator).
CREATE INDEX IF NOT EXISTS chunk_embeddings_d1536_hnsw
    ON chunk_embeddings_d1536 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunk_embeddings_d1024_hnsw
    ON chunk_embeddings_d1024 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunk_embeddings_d768_hnsw
    ON chunk_embeddings_d768 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunk_embeddings_d256_hnsw
    ON chunk_embeddings_d256 USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS attribution_emb_d1536_hnsw
    ON attribution_emb_d1536 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS attribution_emb_d1536_by_lang
    ON attribution_emb_d1536 (language, embed_model);

CREATE INDEX IF NOT EXISTS attribution_emb_d1024_hnsw
    ON attribution_emb_d1024 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS attribution_emb_d1024_by_lang
    ON attribution_emb_d1024 (language, embed_model);

CREATE INDEX IF NOT EXISTS attribution_emb_d768_hnsw
    ON attribution_emb_d768 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS attribution_emb_d768_by_lang
    ON attribution_emb_d768 (language, embed_model);

CREATE INDEX IF NOT EXISTS attribution_emb_d256_hnsw
    ON attribution_emb_d256 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS attribution_emb_d256_by_lang
    ON attribution_emb_d256 (language, embed_model);
