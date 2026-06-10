-- Per-language partial HNSW indexes for the lecture lane.
--
-- WHY ───────────────────────────────────────────────────────────────────
-- Migration 0035 gave each kind its own partial HNSW index. That fixed the
-- verse/library lanes (multi-second → ~0.4s), but the lecture lane
-- (kind='track_transcript') stayed slow (~2-6s warm). track_transcript is
-- the largest partial (~320k) and is mixed-language (en ~227k, ru ~96k);
-- a `lang='ru'` query filters AFTER the kind-only index, so HNSW iterates
-- deep past the en-majority neighbours to collect K ru rows.
--
-- A composite partial keyed on (kind, lang) holds only that language, so
-- the lecture ANN returns K directly. Measured on prod-scale local data:
-- the worst-case lecture probe drops from ~1.1-2.2s to ~84ms. Answer
-- quality is unchanged — same vectors, same ANN, just a tighter index.
--
-- Only track_transcript needs this: verse (~54k) and the library lanes
-- (~91k) are small enough that the kind-only partial already serves them
-- in ~0.4s. The kind-only `_hnsw_lec` index stays as the fallback for
-- lang-less queries (the `lang=None` retry path).
--
-- Languages: en + ru are the only track_transcript langs in the corpus.
-- A query in any other lang (or lang-less) falls back to `_hnsw_lec`.
--
-- OPERATOR ACTION (same as 0035): the index builds are heavy CPU/RAM; the
-- chat service is blocked on the table while they run. A clean compose up
-- (chat depends_on migrator) handles this; if invoked while chat is live,
-- stop chat for the window.

SET lock_timeout = '30s';
SET maintenance_work_mem = '2GB';

DO $$
DECLARE
    dim   int;
    dims  int[] := ARRAY[256, 768, 1024, 1536];
    lng   text;
    langs text[] := ARRAY['en', 'ru'];
    tbl   text;
BEGIN
    FOREACH dim IN ARRAY dims LOOP
        tbl := format('chunk_embeddings_d%s', dim);
        FOREACH lng IN ARRAY langs LOOP
            EXECUTE format(
                'CREATE INDEX IF NOT EXISTS %I ON %I USING hnsw (embedding vector_cosine_ops) '
                'WHERE kind = ''track_transcript'' AND lang = %L',
                format('%s_hnsw_lec_%s', tbl, lng), tbl, lng);
        END LOOP;
    END LOOP;
END $$;
