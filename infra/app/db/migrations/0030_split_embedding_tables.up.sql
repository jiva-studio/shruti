-- Split per-dim embedding columns into separate physical tables.
-- Original `chunks` and `attribution_embeddings` hardcoded
-- `embedding vector(1536)` (migrations 0010 / 0016) — fixed at the dim
-- of OpenAI text-embedding-3-small. New deployments using a different
-- embed provider (Yandex 256-dim, GigaChat 1024-dim, Gemini 768-dim)
-- can't coexist with that single column.
--
-- Strategy:
--   - chunks: drop `embedding` column + its HNSW index
--   - chunk_embeddings_d{N}: new (chunk_id PK FK CASCADE,
--     embedding vector(N)) for N in {256, 768, 1024, 1536}, each with
--     its own HNSW index
--   - attribution_embeddings: drop `embedding` column + its HNSW index
--   - attribution_emb_d{N}: new (attribution_id, language, text,
--     embed_model, embedding vector(N)) mirroring the composite PK of
--     attribution_embeddings, with FK CASCADE on (attribution_id,
--     language, text, embed_model)
--
-- Existing rows in `chunks` / `attribution_embeddings` are preserved:
--   - INSERT ... SELECT moves the current 1536-dim vectors into
--     chunk_embeddings_d1536 / attribution_emb_d1536
--   - Then the `embedding` column on the source table is dropped
--
-- The active dim is selected at runtime by `EmbeddingTableRouter`
-- (Python side). The indexer writes into the d{N} table matching its
-- embedder; queries JOIN through the same table.

-- ── chunks ─────────────────────────────────────────────────────────────
CREATE TABLE chunk_embeddings_d1536 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(1536) NOT NULL
);
CREATE INDEX chunk_embeddings_d1536_hnsw
    ON chunk_embeddings_d1536 USING hnsw (embedding vector_cosine_ops);

INSERT INTO chunk_embeddings_d1536 (chunk_id, embedding)
SELECT id, embedding FROM chunks;

CREATE TABLE chunk_embeddings_d1024 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL
);
CREATE INDEX chunk_embeddings_d1024_hnsw
    ON chunk_embeddings_d1024 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE chunk_embeddings_d768 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(768) NOT NULL
);
CREATE INDEX chunk_embeddings_d768_hnsw
    ON chunk_embeddings_d768 USING hnsw (embedding vector_cosine_ops);

CREATE TABLE chunk_embeddings_d256 (
    chunk_id  BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding vector(256) NOT NULL
);
CREATE INDEX chunk_embeddings_d256_hnsw
    ON chunk_embeddings_d256 USING hnsw (embedding vector_cosine_ops);

DROP INDEX IF EXISTS chunks_hnsw;
ALTER TABLE chunks DROP COLUMN embedding;

-- ── attribution_embeddings ─────────────────────────────────────────────
-- The source table has a composite PK (attribution_id, language, text,
-- embed_model). The per-dim tables mirror that PK so the FK CASCADE
-- still flows from `attributions` → `attribution_embeddings` → d{N}.
--
-- The attribution_emb_hnsw index on the source table was partial
-- (WHERE embed_model='openai/text-embedding-3-small'). The per-dim
-- HNSW indices below are unpartial — the table is already partitioned
-- by dim, and embed_model filtering happens in the query WHERE.
CREATE TABLE attribution_emb_d1536 (
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
CREATE INDEX attribution_emb_d1536_hnsw
    ON attribution_emb_d1536 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX attribution_emb_d1536_by_lang
    ON attribution_emb_d1536 (language, embed_model);

INSERT INTO attribution_emb_d1536
    (attribution_id, language, text, embed_model, embedding)
SELECT attribution_id, language, text, embed_model, embedding
FROM attribution_embeddings;

CREATE TABLE attribution_emb_d1024 (
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
CREATE INDEX attribution_emb_d1024_hnsw
    ON attribution_emb_d1024 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX attribution_emb_d1024_by_lang
    ON attribution_emb_d1024 (language, embed_model);

CREATE TABLE attribution_emb_d768 (
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
CREATE INDEX attribution_emb_d768_hnsw
    ON attribution_emb_d768 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX attribution_emb_d768_by_lang
    ON attribution_emb_d768 (language, embed_model);

CREATE TABLE attribution_emb_d256 (
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
CREATE INDEX attribution_emb_d256_hnsw
    ON attribution_emb_d256 USING hnsw (embedding vector_cosine_ops);
CREATE INDEX attribution_emb_d256_by_lang
    ON attribution_emb_d256 (language, embed_model);

DROP INDEX IF EXISTS attribution_emb_hnsw;
ALTER TABLE attribution_embeddings DROP COLUMN embedding;
