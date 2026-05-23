-- Attributions: curated text → refs mapping used in research pipeline.
-- Two kinds:
--   - 'question' : matched user query takes SHORT path
--   - 'topic'    : matched extracted topics BOOST score in fanout
--
-- Mirrors shruti-mcp library_attributions* tables. Metadata only here;
-- text variants and their embeddings live in attribution_embeddings.

CREATE TABLE attributions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('question', 'topic')),
    refs        JSONB NOT NULL,                  -- [{"ref_kind":"verse"|"document","target_id":"<opaque>"}, ...]
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX attributions_by_kind ON attributions (kind);
