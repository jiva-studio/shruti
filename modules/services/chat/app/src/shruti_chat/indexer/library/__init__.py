"""Library corpus indexing — verses, commentaries, prose chapters, letters.

Lands chunks in the same `chunks` table as transcripts, discriminated by
the `kind` column ('verse' / 'commentary' / 'prose_chapter' / 'letter').
The link between a commentary chunk and its parent verse is derived from
(source_id, tokens) — same convention as inside library.db.
"""
