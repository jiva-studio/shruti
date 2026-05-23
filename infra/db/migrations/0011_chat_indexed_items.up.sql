-- Index registry — one row per (item_kind, item_id, lang, embed_model).
-- Tells the indexer whether the underlying source has changed since we
-- last embedded it. Generic across content kinds: `etag` is opaque
-- (S3 ETag for transcripts; sha256(body) for library items).

CREATE TABLE indexed_items (
    item_kind   TEXT NOT NULL,    -- 'track_transcript' | 'verse' | 'commentary' | 'prose_chapter' | 'letter' | 'attribution'
    item_id     TEXT NOT NULL,
    lang        TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    etag        TEXT NOT NULL,    -- S3 ETag for transcripts; sha256(body) for library
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_kind, item_id, lang, embed_model)
);
