-- Shruti chat schema. Idempotent: safe to apply on every startup.
-- See plan §"Data model" for the rationale.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
    id                  BIGSERIAL PRIMARY KEY,
    track_id            TEXT NOT NULL,
    lang                TEXT NOT NULL,
    start_ms            INT NOT NULL,
    end_ms              INT NOT NULL,
    text                TEXT NOT NULL,
    reference_source_id TEXT,
    embed_model         TEXT NOT NULL,
    embedding           vector(1536) NOT NULL   -- text-embedding-3-small dim
);
CREATE INDEX IF NOT EXISTS chunks_track ON chunks (track_id, lang);
CREATE INDEX IF NOT EXISTS chunks_model ON chunks (embed_model);
CREATE INDEX IF NOT EXISTS chunks_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops);

-- Index registry — one row per (item_kind, item_id, lang, embed_model) tells
-- us whether the underlying source has changed since we last embedded it.
-- Generic across content kinds: `etag` is opaque to the indexer (S3 ETag
-- for transcripts; sha256(body) for library items).
--
-- Pre-existing deployments have `indexed_tracks` from the transcript era —
-- the DO block migrates it in place so existing per-track ETags carry over
-- and we don't re-embed the whole transcript corpus on next tick.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'indexed_tracks')
       AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'indexed_items') THEN
        ALTER TABLE indexed_tracks RENAME TO indexed_items;
        ALTER TABLE indexed_items ADD COLUMN item_kind TEXT;
        UPDATE indexed_items SET item_kind = 'track_transcript' WHERE item_kind IS NULL;
        ALTER TABLE indexed_items ALTER COLUMN item_kind SET NOT NULL;
        ALTER TABLE indexed_items RENAME COLUMN track_id TO item_id;
        ALTER TABLE indexed_items DROP CONSTRAINT IF EXISTS indexed_tracks_pkey;
        ALTER TABLE indexed_items ADD PRIMARY KEY (item_kind, item_id, lang, embed_model);
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS indexed_items (
    item_kind   TEXT NOT NULL,    -- 'track_transcript' | 'verse' | 'commentary' | 'prose_chapter' | 'letter'
    item_id     TEXT NOT NULL,
    lang        TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    etag        TEXT NOT NULL,    -- S3 ETag for transcripts; sha256(body) for library
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_kind, item_id, lang, embed_model)
);

-- Source DB state — current local version of each downloadable artifact
-- (catalog/current.db, library/library.db). Replaces the old single-row
-- catalog_state table; same migration pattern.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'catalog_state')
       AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'db_state') THEN
        ALTER TABLE catalog_state RENAME TO db_state;
        ALTER TABLE db_state ADD COLUMN kind TEXT;
        UPDATE db_state SET kind = 'catalog' WHERE kind IS NULL;
        ALTER TABLE db_state ALTER COLUMN kind SET NOT NULL;
        ALTER TABLE db_state DROP CONSTRAINT IF EXISTS catalog_state_pkey;
        ALTER TABLE db_state DROP CONSTRAINT IF EXISTS catalog_state_id_check;
        ALTER TABLE db_state DROP COLUMN id;
        ALTER TABLE db_state ADD PRIMARY KEY (kind);
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS db_state (
    kind            TEXT PRIMARY KEY,    -- 'catalog' | 'library'
    current_version TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage (
    key   TEXT NOT NULL,
    day   DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
);

CREATE TABLE IF NOT EXISTS indexer_runs (
    id            BIGSERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL UNIQUE,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    state         TEXT NOT NULL,
    trigger       TEXT NOT NULL,
    catalog_from  TEXT,
    catalog_to    TEXT,
    tracks_total  INT,
    tracks_done   INT,
    chunks_total  INT,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_indexer_runs_started
    ON indexer_runs (started_at DESC);

-- ── Library corpus (verses + commentaries + prose + letters) ──────────
--
-- Imported from library.db (published independently of the catalog). Lands
-- in the SAME chunks table as transcripts — a `kind` discriminator and a
-- few nullable columns hold the library-specific metadata. Embedding model
-- and ANN index are shared; only the WHERE filter differs at query time.
--
-- The link between a commentary chunk and its parent verse is derived from
-- (source_id, tokens) — same convention as inside library.db.

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS kind          TEXT NOT NULL DEFAULT 'track_transcript',
    ADD COLUMN IF NOT EXISTS item_id       TEXT,
    ADD COLUMN IF NOT EXISTS source_id     TEXT,
    ADD COLUMN IF NOT EXISTS tokens        TEXT,
    ADD COLUMN IF NOT EXISTS author_id     TEXT,
    ADD COLUMN IF NOT EXISTS doc_date      TEXT,
    ADD COLUMN IF NOT EXISTS segment_index INT,
    ADD COLUMN IF NOT EXISTS addr_label    TEXT;

-- Legacy NOT NULL constraints on track-only columns relaxed so library
-- rows can omit them. DROP NOT NULL is a no-op on already-nullable columns.
ALTER TABLE chunks ALTER COLUMN track_id DROP NOT NULL;
ALTER TABLE chunks ALTER COLUMN start_ms DROP NOT NULL;
ALTER TABLE chunks ALTER COLUMN end_ms   DROP NOT NULL;

CREATE INDEX IF NOT EXISTS chunks_kind       ON chunks (kind);
CREATE INDEX IF NOT EXISTS chunks_lib_item   ON chunks (item_id, lang) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_lib_addr   ON chunks (source_id, tokens) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chunks_lib_author ON chunks (author_id) WHERE author_id IS NOT NULL;

-- Library diff state and version live in the shared `indexed_items` /
-- `db_state` tables defined above (discriminated by item_kind / kind).

-- ── Attributions (question / topic) ───────────────────────────────────
--
-- Mirrors the shruti-mcp library_attributions* tables. Curated text →
-- refs mapping with two kinds:
--   - 'question' : matched user query takes SHORT path in research pipeline
--   - 'topic'    : matched extracted topics BOOST score (+0.15) in fanout
--
-- `attributions` holds metadata (id, kind, refs JSONB). Text variants and
-- their embeddings live in `attribution_embeddings` — one row per
-- (attribution_id, language, text, embed_model) so N phrasings per (id,lang)
-- can coexist ("что такое разум" + "природа разума" both index).
--
-- Diff via `indexed_items` with item_kind='attribution'; etag is sha256 of
-- the sorted-joined-texts for one (attribution_id, lang).

CREATE TABLE IF NOT EXISTS attributions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('question', 'topic')),
    refs        JSONB NOT NULL,        -- [{"ref_kind":"verse"|"document","target_id":"<opaque>"}, …]
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attributions_by_kind ON attributions(kind);

CREATE TABLE IF NOT EXISTS attribution_embeddings (
    attribution_id TEXT NOT NULL REFERENCES attributions(id) ON DELETE CASCADE,
    language       TEXT NOT NULL,
    text           TEXT NOT NULL CHECK (length(text) < 1000),
    embedding      vector(1536) NOT NULL,
    embed_model    TEXT NOT NULL,
    PRIMARY KEY (attribution_id, language, text, embed_model)
);

-- Partial HNSW index pinned to the active model. Avoids mixing vector spaces
-- after an embed_model swap; old vectors coexist in the table but the index
-- only sees the current model. Change the WHERE clause if rolling forward to
-- a new model (or build a parallel index for staged rollout).
CREATE INDEX IF NOT EXISTS attribution_emb_hnsw
    ON attribution_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WHERE embed_model = 'openai/text-embedding-3-small';

CREATE INDEX IF NOT EXISTS attribution_emb_by_lang
    ON attribution_embeddings (language, embed_model);
