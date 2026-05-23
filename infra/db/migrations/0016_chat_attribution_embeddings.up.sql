-- Per-attribution text variants + their embeddings.
-- N phrasings per (attribution_id, lang) can coexist:
--   "что такое разум" + "природа разума" both index for the same attribution.
--
-- Partial HNSW pinned to active model — avoids mixing vector spaces after
-- an embed_model swap. Old vectors stay in the table but the index only
-- sees the current model. Change WHERE if rolling forward to a new model.

CREATE TABLE attribution_embeddings (
    attribution_id TEXT NOT NULL REFERENCES attributions(id) ON DELETE CASCADE,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL CHECK (length(text) < 1000),
    embedding      vector(1536) NOT NULL,
    embed_model    TEXT NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model)
);

CREATE INDEX attribution_emb_hnsw
    ON attribution_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WHERE embed_model = 'openai/text-embedding-3-small';

CREATE INDEX attribution_emb_by_lang
    ON attribution_embeddings (language, embed_model);
