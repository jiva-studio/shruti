-- Chunks: unified embedding storage for transcripts AND library corpus
-- (verses, commentaries, prose chapters, letters). `kind` discriminator
-- + nullable per-kind columns keep both worlds in one table sharing the
-- same HNSW index. WHERE filter at query time switches between kinds.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id                  BIGSERIAL PRIMARY KEY,
    -- Common across all kinds.
    lang                TEXT NOT NULL,
    text                TEXT NOT NULL,
    embed_model         TEXT NOT NULL,
    embedding           vector(1536) NOT NULL,   -- text-embedding-3-small dim
    kind                TEXT NOT NULL DEFAULT 'track_transcript',
    reference_source_id TEXT,
    -- Track-transcript-only (nullable for library kinds).
    track_id            TEXT,
    start_ms            INT,
    end_ms              INT,
    -- Library corpus columns (nullable for transcripts).
    item_id             TEXT,
    source_id           TEXT,
    tokens              TEXT,
    author_id           TEXT,
    doc_date            TEXT,
    segment_index       INT,
    addr_label          TEXT
);

CREATE INDEX chunks_track ON chunks (track_id, lang);
CREATE INDEX chunks_model ON chunks (embed_model);
CREATE INDEX chunks_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_kind       ON chunks (kind);
CREATE INDEX chunks_lib_item   ON chunks (item_id, lang)             WHERE item_id IS NOT NULL;
CREATE INDEX chunks_lib_addr   ON chunks (source_id, tokens)         WHERE source_id IS NOT NULL;
CREATE INDEX chunks_lib_author ON chunks (author_id)                 WHERE author_id IS NOT NULL;
