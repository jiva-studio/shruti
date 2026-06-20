-- Memory attributions: a third kind alongside pinned/boost. A 'memory' is a
-- curator note (background context the synthesizer injects but never cites)
-- plus refs to existing resources. Mirrors the shruti-mcp library.db
-- (kind=memory + library_attribution_notes + optional ref language).
--
-- Widen the kind CHECK (Postgres swaps a CHECK in place — no table rebuild).
ALTER TABLE attributions DROP CONSTRAINT attributions_kind_check;
ALTER TABLE attributions ADD CONSTRAINT attributions_kind_check CHECK (kind IN ('pinned', 'boost', 'memory'));

-- The note text the indexer mirrors from library_attribution_notes: ONE note
-- per (attribution, language). The note is fetched at injection time; its
-- chunks are embedded into attribution_emb_d{N} alongside triggers (so a note
-- match surfaces the memory), but the full text lives here for injection.
CREATE TABLE attribution_notes (
    attribution_id TEXT NOT NULL REFERENCES attributions(id) ON DELETE CASCADE,
    language       TEXT NOT NULL,
    note           TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attribution_id, language)
);

-- attributions.refs (JSONB) gains an optional per-entry "language" key
-- ({"ref_kind":"track","target_id":"track_x@..","language":"en"}); no DDL
-- needed for the JSONB itself — this comment documents the shape.
