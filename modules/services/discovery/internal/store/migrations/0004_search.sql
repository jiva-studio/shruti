-- What is searchable about a recording.
--
-- Two lanes run over these — vector similarity and lexical match — and their
-- rankings are fused: meaning alone misses an exact reference someone typed,
-- words alone miss a paraphrase.
--
-- A chunk belongs to a recording, never to a page. Page text was being embedded
-- for every file on a listing, and on a listing that text is the site's menu and
-- the names of the neighbouring files: 2500 vectors of navigation against 31 of
-- anything else.

CREATE TABLE IF NOT EXISTS discovery.chunks (
    id        bigserial PRIMARY KEY,
    item_id   bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    -- title:     the recording's own name, and nothing else. The speaker, the
    --            date and the references are exact filters and live in columns;
    --            mixing them into the vector only blurs what it is about.
    -- page_text: prose the archive itself published about this recording. A
    --            search key, never a transcript: citations cut audio against our
    --            own re-encode, and no external timing survives that.
    kind      text NOT NULL,
    -- The language of this piece, where the archive stated one. A recording can
    -- carry a transcript in several languages and each is chunked separately;
    -- without this a hit cannot say which of them it came from.
    --
    -- Nothing filters on it today: the embedding model is multilingual, and a
    -- question asked in Russian finding an English transcript of the same talk
    -- is wanted rather than a fault. It is here so that narrowing later is a
    -- decision rather than a re-index.
    lang      text NOT NULL DEFAULT '',
    ordinal   integer NOT NULL DEFAULT 0,
    text      text NOT NULL,
    embedding vector(1536),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunks_item_idx ON discovery.chunks (item_id, kind);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON discovery.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON discovery.chunks USING gin (to_tsvector('simple', text));

-- Vectors already paid for, kept by what was embedded rather than by which
-- recording wanted it.
--
-- The same title recurs across an archive — one page carried twenty nine "Hare
-- Krishna Kirtan" — and a corpus is re-indexed every time a prompt changes.
-- Without this, each pass buys the same vectors again.
--
-- Keyed by model as well as text: a vector from another model is not comparable,
-- so an old one must miss rather than quietly mix in.
CREATE TABLE IF NOT EXISTS discovery.embeddings (
    model       text NOT NULL,
    text_sha256 text NOT NULL,
    text        text NOT NULL,
    embedding   vector(1536) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (model, text_sha256)
);
