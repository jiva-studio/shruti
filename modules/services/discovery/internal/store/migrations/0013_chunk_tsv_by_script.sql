-- Words, indexed in the language they are written in.
--
-- The lexical lane used the `simple` configuration for everything: no stemming,
-- and no stop words either. That cost it every question shaped like a sentence
-- — "лекции о карме" became 'лекции' & 'о' & 'карме', and neither the
-- preposition nor the case ending is in any title, so seven questions of eight
-- matched nothing at all and the fusion of two lanes was a fusion of one.
--
-- The script decides, not the stored language. 22,448 chunks carry Cyrillic
-- with no language recorded, and 28,185 recorded as Hindi carry none — the
-- column describes what a caption track was labelled, and the text is the only
-- thing that cannot be mislabelled.
CREATE OR REPLACE FUNCTION discovery.chunk_tsv(body text) RETURNS tsvector
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT to_tsvector(
    CASE WHEN body ~ '[А-Яа-яЁё]' THEN 'russian'::regconfig ELSE 'english'::regconfig END,
    body)
$$;

-- Without this every search is the full scan of 414 MB that made the question
-- above take five minutes to answer once.
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON discovery.chunks USING gin (discovery.chunk_tsv(text));

-- The same words, asked for one at a time. A sentence is looked for whole
-- first; when the corpus holds no chunk carrying every word of it, this is what
-- it is loosened to, and ts_rank puts whatever carried most of them on top.
CREATE OR REPLACE FUNCTION discovery.words_tsquery(phrase text) RETURNS tsquery
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT nullif(
    (SELECT string_agg(quote_literal(w), ' | ')
     FROM (
       SELECT DISTINCT unnest(tsvector_to_array(discovery.chunk_tsv(phrase))) AS w
     ) lexemes), '')::tsquery
$$;
