-- Prose an archive published about a recording, kept whole.
--
-- The chunks in discovery.chunks are this text cut up for search. Keeping the
-- source as well is the same bargain as items.raw: cutting it differently later
-- is then a local decision rather than a reason to crawl a site again.
--
-- Markdown, not markup. What arrives is somebody's HTML and it is converted on
-- the way in, so nothing downstream has to know which tags a particular archive
-- happened to use.
--
-- This is a search key and never a transcript of ours. Our citations cut audio
-- by milliseconds against our own re-encode, and no external timing survives
-- that — which is why the timings this one site publishes are dropped rather
-- than stored to be trusted later.
-- One recording can hold several of these. An archive that publishes its own
-- subtitles publishes them in every language it has a translator for, and each
-- is separate work rather than a copy — so the language is part of what
-- identifies a text, not a note about it.
--
-- An empty lang means the archive did not say. It does not mean English, and
-- nothing here guesses a language from the words.
CREATE TABLE IF NOT EXISTS discovery.item_texts (
    item_id    bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    kind       text NOT NULL,
    lang       text NOT NULL DEFAULT '',
    text       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, kind, lang)
);
