CREATE TABLE library_attributions (
			id          TEXT PRIMARY KEY,
			kind        TEXT NOT NULL CHECK (kind IN ('question', 'topic')),
			created_at  TIMESTAMP NOT NULL,
			updated_at  TIMESTAMP NOT NULL
		);

CREATE INDEX library_attributions_by_kind
			ON library_attributions(kind);

CREATE TABLE library_attribution_texts (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			language       TEXT NOT NULL,
			text           TEXT NOT NULL,
			PRIMARY KEY (attribution_id, language, text)
		);

CREATE TABLE library_attribution_refs (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind       TEXT NOT NULL CHECK (ref_kind IN ('verse', 'document')),
			target_id      TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (attribution_id, ref_kind, target_id)
		);

CREATE INDEX library_attr_refs_by_target
			ON library_attribution_refs(ref_kind, target_id);

INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES
  ('canonical_a', 'question', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z'),
  ('canonical_b', 'topic', '2026-05-02T00:00:00Z', '2026-05-02T00:00:00Z');

INSERT INTO library_attribution_texts (attribution_id, language, text) VALUES
  ('canonical_a', 'ru', 'что такое разум'),
  ('canonical_b', 'en', 'nature of mind');

INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id, position) VALUES
  ('canonical_a', 'verse', 'v_bg_2_13', 0),
  ('canonical_b', 'document', 'd_bg_2_13', 1);
