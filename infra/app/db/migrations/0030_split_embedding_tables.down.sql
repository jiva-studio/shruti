-- Reverse of 0030: re-create the `embedding` column on `chunks` and
-- `attribution_embeddings` as vector(1536), copy data back from the
-- d1536 per-dim tables, then drop all chunk_embeddings_d{N} /
-- attribution_emb_d{N} tables.
--
-- Lossy only for deployments that wrote into a non-1536 dim table
-- (RU with d256, etc.) — those rows have no slot in the restored
-- 1536-column. We do NOT attempt to migrate them; rolling this back
-- on such a deployment requires a full reindex anyway.

-- ── chunks ─────────────────────────────────────────────────────────────
ALTER TABLE chunks ADD COLUMN embedding vector(1536);

UPDATE chunks c
   SET embedding = e.embedding
  FROM chunk_embeddings_d1536 e
 WHERE e.chunk_id = c.id;

-- Restore NOT NULL only if the d1536 table had a row for every chunk;
-- otherwise leave nullable to preserve any pre-existing non-d1536 rows
-- (their embedding stays NULL — rolling back across a dim change is
-- understood as data-loss for those rows, surfaced by the NULL).
DO $$
DECLARE
    missing BIGINT;
BEGIN
    SELECT COUNT(*) INTO missing
      FROM chunks WHERE embedding IS NULL;
    IF missing = 0 THEN
        ALTER TABLE chunks ALTER COLUMN embedding SET NOT NULL;
    END IF;
END $$;

CREATE INDEX chunks_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops);

DROP TABLE IF EXISTS chunk_embeddings_d256;
DROP TABLE IF EXISTS chunk_embeddings_d768;
DROP TABLE IF EXISTS chunk_embeddings_d1024;
DROP TABLE IF EXISTS chunk_embeddings_d1536;

-- ── attribution_embeddings ─────────────────────────────────────────────
ALTER TABLE attribution_embeddings ADD COLUMN embedding vector(1536);

UPDATE attribution_embeddings ae
   SET embedding = d.embedding
  FROM attribution_emb_d1536 d
 WHERE d.attribution_id = ae.attribution_id
   AND d.language       = ae.language
   AND d.text           = ae.text
   AND d.embed_model    = ae.embed_model;

DO $$
DECLARE
    missing BIGINT;
BEGIN
    SELECT COUNT(*) INTO missing
      FROM attribution_embeddings WHERE embedding IS NULL;
    IF missing = 0 THEN
        ALTER TABLE attribution_embeddings ALTER COLUMN embedding SET NOT NULL;
    END IF;
END $$;

CREATE INDEX attribution_emb_hnsw
    ON attribution_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WHERE embed_model = 'openai/text-embedding-3-small';

DROP TABLE IF EXISTS attribution_emb_d256;
DROP TABLE IF EXISTS attribution_emb_d768;
DROP TABLE IF EXISTS attribution_emb_d1024;
DROP TABLE IF EXISTS attribution_emb_d1536;
