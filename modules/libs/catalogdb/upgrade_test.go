package catalogdb

import "testing"

// A reference table that already scopes references to a language but still
// checks ref_kind is rebuilt without the check, and keeps every language.
func TestRelaxingRefKindKeepsTheLanguageOfEachReference(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := openFile(t, d)
		execScript(t, db, "legacy_library_attributions.sql")
		mustExec(t, db, `ALTER TABLE library_attribution_refs ADD COLUMN language TEXT`)
		mustExec(t, db, `UPDATE library_attribution_refs SET language = 'ru' WHERE attribution_id = 'canonical_a'`)

		if err := MigrateLibrary(t.Context(), db); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		if checked, err := refKindIsChecked(t.Context(), db); err != nil || checked {
			t.Fatalf("ref_kind still checked (err %v)", err)
		}
		got := queryStrings(t, db, `SELECT attribution_id || ':' || coalesce(language, '*') FROM library_attribution_refs ORDER BY attribution_id`)
		if len(got) != 2 || got[0] != "canonical_a:ru" || got[1] != "canonical_b:*" {
			t.Fatalf("reference languages after the rebuild: %v", got)
		}
	})
}

// A file whose migrations table lacks rows for some steps (here 009–017,
// beside a NULL-scheme 007 row) gets those steps recorded without its schema,
// scheme or content changing.
func TestACatalogWithUnrecordedStepsUpgradesInPlace(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		mustExec(t, db, `INSERT INTO tracks (id, date) VALUES ('t1', '1974-10-20')`)
		mustExec(t, db, `INSERT INTO track_variants (track_id, language, title, audio_path)
			VALUES ('t1', 'ru', 'Учёные', 'public/tracks/t1/audio/original.mp3')`)
		tx, err := db.BeginTx(t.Context(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := ReindexTrackSearch(t.Context(), tx, "t1"); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		mustExec(t, db, `DELETE FROM track_audio`)
		mustExec(t, db, `INSERT INTO track_audio (track_id, language, kind, path) VALUES ('t1', 'ru', 'clean', 'c.mp3')`)
		mustExec(t, db, `DELETE FROM tags WHERE id = 'tag_bhajan' AND language = 'en'`)
		mustExec(t, db, `DELETE FROM migrations WHERE name >= '009'`)
		mustExec(t, db, `INSERT INTO migrations (name, scheme, applied_at) VALUES ('007_fold_fts_yo', NULL, 0)`)
		search := queryStrings(t, db, `SELECT kind || ':' || content FROM tracks_search ORDER BY kind, content`)

		if err := MigrateCatalog(t.Context(), db); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		assertPublishedSchema(t, db, "current.schema.sql")
		if scheme, err := ReadScheme(t.Context(), db); err != nil || scheme != Scheme {
			t.Fatalf("scheme %d (err %v), want %d", scheme, err, Scheme)
		}
		if got := queryStrings(t, db, `SELECT kind || ':' || content FROM tracks_search ORDER BY kind, content`); len(got) != len(search) {
			t.Fatalf("search rows rebuilt: %v, was %v", got, search)
		}
		// The track_audio step is recorded, so it does not re-derive an
		// `original` row the curator removed.
		if got := queryStrings(t, db, `SELECT kind FROM track_audio`); len(got) != 1 || got[0] != "clean" {
			t.Fatalf("track_audio rewritten: %v", got)
		}
		// The kind tags are seeded by an unrecorded step, so a missing one comes back.
		if n := queryInt(t, db, `SELECT COUNT(*) FROM tags WHERE id = 'tag_bhajan'`); n != 2 {
			t.Fatalf("kind tag not reseeded: %d rows", n)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM migrations WHERE name >= '009'`); n != 9 {
			t.Fatalf("%d of 9 later steps recorded", n)
		}
		if err := MigrateCatalog(t.Context(), db); err != nil {
			t.Fatalf("second migrate: %v", err)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM tags WHERE id = 'tag_bhajan'`); n != 2 {
			t.Fatalf("second open changed tags: %d rows", n)
		}
	})
}
