-- What an archive says about itself, which is the only thing that decides how
-- it is read.
--
-- 'material' — the archive states nothing a machine can read. A script, or no
--   script at all, collects what the page holds and hands it over labelled; the
--   model reads all of it. idt, every YouTube channel, and anything new.
--
-- 'stated' — the archive publishes its own facts: schema.org, an API. They are
--   taken as given and no model is ever called. audioveda.
--
-- There is nothing between the two, and that is the point. The middle case --
-- a script that half-reads a line and hands the remainder on -- is what put a
-- per-item flag in the script contract, a reason string on every row, and a
-- merge that took the model's answer whole because it could not tell which
-- half was which.
--
-- material is the default because it is the safe half: it costs a call and
-- gets an answer. Defaulting to stated would store a new source's recordings
-- with whatever its absent script emitted -- nothing -- stamp them normalized
-- and seal them with a hash, so nothing would ever ask again.
ALTER TABLE discovery.sources
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'material';

ALTER TABLE discovery.sources
    DROP CONSTRAINT IF EXISTS sources_kind_check;
ALTER TABLE discovery.sources
    ADD CONSTRAINT sources_kind_check CHECK (kind IN ('material', 'stated'));

UPDATE discovery.sources SET kind = 'stated'
 WHERE coalesce(nullif(script, ''), id) = 'audioveda';
