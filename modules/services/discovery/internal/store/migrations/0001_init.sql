-- discovery: an index of lecture audio that exists on public archives.
--
-- Nothing here is per-source. A source is a seed URL and politeness settings;
-- everything else is text read off whatever the site returned.

CREATE SCHEMA IF NOT EXISTS discovery;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS discovery.sources (
    id          text PRIMARY KEY,
    title       text NOT NULL DEFAULT '',
    seed_urls   text[] NOT NULL,
    enabled     boolean NOT NULL DEFAULT false,
    crawl_delay_ms integer NOT NULL DEFAULT 1000,
    max_depth   integer NOT NULL DEFAULT 6,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per URL we have fetched. Carries the validators that let a recheck
-- cost one conditional GET, and the schedule that decides when that is.
CREATE TABLE IF NOT EXISTS discovery.pages (
    id          bigserial PRIMARY KEY,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    url         text NOT NULL UNIQUE,
    etag        text,
    last_modified text,
    body_sha256 text,
    -- Hash of the set of media URLs found. A listing whose surrounding markup
    -- churns but whose files are the same has not changed for our purposes.
    item_set_sha256 text,
    http_status integer,
    error       text,
    last_fetched_at timestamptz,
    last_changed_at timestamptz,
    consecutive_unchanged integer NOT NULL DEFAULT 0,
    next_check_at timestamptz
);

CREATE INDEX IF NOT EXISTS pages_due_idx
    ON discovery.pages (next_check_at)
    WHERE next_check_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_source_idx ON discovery.pages (source_id);

-- One row per media file. media_url is the natural key: the same recording
-- published on two sites is two rows, because provenance must survive.
CREATE TABLE IF NOT EXISTS discovery.items (
    id          bigserial PRIMARY KEY,
    media_url   text NOT NULL UNIQUE,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    page_id     bigint REFERENCES discovery.pages(id) ON DELETE SET NULL,

    -- raw is everything extraction found: filename, path segments, the text
    -- around the link, container tags. It is the normalizer's input and it is
    -- kept so a prompt change can be replayed without refetching.
    raw         jsonb NOT NULL DEFAULT '{}'::jsonb,

    title       text,
    author      text,
    location    text,
    recorded_on date,
    language    text,
    duration_s  integer,
    ref_source  text,
    ref_part    text,
    ref_tokens  text,

    media_available boolean NOT NULL DEFAULT true,
    media_blocked   text,

    -- Skip levers: rebuild the normalizer input, hash it, and do nothing when
    -- the hash, the prompt version and the model all match.
    norm_input_sha256 text,
    norm_prompt_version text,
    norm_model  text,

    status      text NOT NULL DEFAULT 'discovered',
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_source_idx ON discovery.items (source_id);
CREATE INDEX IF NOT EXISTS items_status_idx ON discovery.items (status);
CREATE INDEX IF NOT EXISTS items_page_idx ON discovery.items (page_id);
CREATE INDEX IF NOT EXISTS items_author_idx ON discovery.items (author) WHERE author IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_ref_idx ON discovery.items (ref_source, ref_tokens) WHERE ref_source IS NOT NULL;

-- Grouping a source publishes: a playlist, a category, a seminar directory.
CREATE TABLE IF NOT EXISTS discovery.collections (
    id          bigserial PRIMARY KEY,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    external_id text,
    url         text,
    title       text NOT NULL DEFAULT '',
    description text,
    author      text,
    member_count integer NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS discovery.collection_items (
    collection_id bigint NOT NULL REFERENCES discovery.collections(id) ON DELETE CASCADE,
    item_id     bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    ordinal     integer,
    PRIMARY KEY (collection_id, item_id)
);

-- Searchable text. source_id and language are denormalized onto this table on
-- purpose: filtering across a join defeats the vector index.
CREATE TABLE IF NOT EXISTS discovery.chunks (
    id          bigserial PRIMARY KEY,
    item_id     bigint REFERENCES discovery.items(id) ON DELETE CASCADE,
    page_id     bigint REFERENCES discovery.pages(id) ON DELETE CASCADE,
    source_id   text,
    language    text,
    -- canonical: this recording's own words. shared: text the page carries for
    -- everything on it — searchable, never quotable as speech.
    role        text NOT NULL DEFAULT 'canonical',
    ordinal     integer NOT NULL DEFAULT 0,
    text        text NOT NULL,
    embedding   vector(1536),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_item_idx ON discovery.chunks (item_id);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
    ON discovery.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_fts_idx
    ON discovery.chunks USING gin (to_tsvector('simple', text));

CREATE TABLE IF NOT EXISTS discovery.runs (
    id          bigserial PRIMARY KEY,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    dry_run     boolean NOT NULL DEFAULT false,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    pages_fetched integer NOT NULL DEFAULT 0,
    pages_unchanged integer NOT NULL DEFAULT 0,
    items_found integer NOT NULL DEFAULT 0,
    items_new   integer NOT NULL DEFAULT 0,
    items_changed integer NOT NULL DEFAULT 0,
    failures    integer NOT NULL DEFAULT 0,
    errors      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS runs_source_idx ON discovery.runs (source_id, started_at DESC);
