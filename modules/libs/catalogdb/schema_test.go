package catalogdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// testdata/current.schema.sql and testdata/library.schema.sql are sqlite_master
// of the files clients download today. Every reader — the mobile app, chat,
// social-poster, analytics, publish-service — depends on that shape, so a
// migrated file must reproduce it statement for statement.

func TestSchemeIsTheOneDBSchemeJSONPublishes(t *testing.T) {
	raw, err := os.ReadFile("../../db-scheme.json")
	if err != nil {
		t.Fatalf("read db-scheme.json: %v", err)
	}
	var f struct {
		Scheme int `json:"scheme"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode db-scheme.json: %v", err)
	}
	if f.Scheme != Scheme {
		t.Fatalf("db-scheme.json says %d, catalogdb.Scheme is %d", f.Scheme, Scheme)
	}
	latest := 0
	for _, s := range catalogPlan.steps {
		latest = max(latest, s.Scheme)
	}
	if latest != Scheme {
		t.Fatalf("the newest catalog step moves the scheme to %d, catalogdb.Scheme is %d", latest, Scheme)
	}
}

func TestFreshCatalogHasThePublishedSchema(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		assertPublishedSchema(t, db, "current.schema.sql")
		scheme, err := ReadScheme(t.Context(), db)
		if err != nil {
			t.Fatal(err)
		}
		if scheme != Scheme {
			t.Fatalf("fresh catalog advertises scheme %d, want %d", scheme, Scheme)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM migrations`); n != len(catalogPlan.steps) {
			t.Fatalf("%d migrations recorded, want %d", n, len(catalogPlan.steps))
		}
	})
}

func TestLegacyCatalogMigratesToThePublishedSchema(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := openFile(t, d)
		execScript(t, db, "legacy_current_003.sql")
		mustExec(t, db, `INSERT INTO tracks (id, date) VALUES ('t1', '1974-10-20'), ('t2', NULL)`)
		mustExec(t, db, `INSERT INTO track_variants (track_id, language, title, audio_path, audio_filesize, audio_duration)
			VALUES ('t1', 'ru', 'Учёные', 'public/tracks/t1/audio/original.mp3', 123, 456000),
			       ('t2', 'en', 'Silent', NULL, NULL, NULL)`)
		mustExec(t, db, `INSERT INTO tracks_search (content, track_id, kind) VALUES ('Учёные', 't1', 'title')`)
		mustExec(t, db, `INSERT INTO packs (id, language, name) VALUES ('p1', 'ru', 'Пак')`)
		mustExec(t, db, `INSERT INTO pack_tracks (pack_id, pack_language, track_id) VALUES ('p1', 'ru', 't1')`)

		if err := MigrateCatalog(t.Context(), db); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		assertPublishedSchema(t, db, "current.schema.sql")

		scheme, err := ReadScheme(t.Context(), db)
		if err != nil {
			t.Fatal(err)
		}
		if scheme != Scheme {
			t.Fatalf("migrated catalog advertises scheme %d, want %d", scheme, Scheme)
		}
		if got := queryStrings(t, db, `SELECT track_id FROM collection_tracks WHERE collection_id = 'p1'`); len(got) != 1 {
			t.Fatalf("pack membership lost in the rename: %v", got)
		}
		if got := queryStrings(t, db, `SELECT kind || ' ' || path FROM track_audio`); len(got) != 1 ||
			got[0] != "original public/tracks/t1/audio/original.mp3" {
			t.Fatalf("track_audio backfill: %v", got)
		}
		if got := queryStrings(t, db, `SELECT content FROM tracks_search WHERE kind = 'title' AND track_id = 't1'`); len(got) != 1 || got[0] != "Ученые" {
			t.Fatalf("existing search rows not folded: %v", got)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM tracks_search WHERE kind = 'combined'`); n != 2 {
			t.Fatalf("%d combined search rows, want one per track", n)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM tags WHERE id = 'tag_bhajan'`); n != 2 {
			t.Fatalf("kind tags not seeded: %d rows", n)
		}
	})
}

func TestLegacyFeaturedPackBecomesFeaturedTagMembership(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := openFile(t, d)
		execScript(t, db, "legacy_current_003.sql")
		mustExec(t, db, `ALTER TABLE packs ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`)
		mustExec(t, db, `INSERT INTO packs (id, language, name, featured) VALUES ('p1', 'ru', 'A', 1), ('p2', 'ru', 'B', 0)`)

		if err := MigrateCatalog(t.Context(), db); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		got := queryStrings(t, db, `SELECT collection_id FROM collection_tags WHERE tag_id = ?`, FeaturedTagID)
		if len(got) != 1 || got[0] != "p1" {
			t.Fatalf("featured membership: %v", got)
		}
		if has, err := columnExists(t.Context(), db, "collections", "featured"); err != nil || has {
			t.Fatalf("featured column still present (err %v)", err)
		}
	})
}

func TestCatalogStepRunsOnce(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		mustExec(t, db, `DELETE FROM tags WHERE id = 'tag_bhajan'`)
		if err := MigrateCatalog(t.Context(), db); err != nil {
			t.Fatalf("second migrate: %v", err)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM tags WHERE id = 'tag_bhajan'`); n != 0 {
			t.Fatalf("a recorded seed ran again: %d rows", n)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM migrations`); n != len(catalogPlan.steps) {
			t.Fatalf("%d migrations recorded after a second run, want %d", n, len(catalogPlan.steps))
		}
	})
}

func TestCatalogRefusesAFileWithoutItsBaseline(t *testing.T) {
	forEachDriver(t, func(t *testing.T, d driver) {
		db := openFile(t, d)
		mustExec(t, db, `CREATE TABLE tracks (id TEXT PRIMARY KEY)`)
		err := MigrateCatalog(t.Context(), db)
		if err == nil || !strings.Contains(err.Error(), "001_init_schema") {
			t.Fatalf("migrate of an unrecognised file: %v", err)
		}
	})
}

func TestFailedStepLeavesNoTraceAndIsNotRecorded(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		boom := errors.New("boom")
		p := catalogPlan
		p.steps = append(append([]Step{}, catalogPlan.steps...), Step{
			Name: "999_fails",
			Up: func(ctx context.Context, tx *sql.Tx) error {
				if _, err := tx.ExecContext(ctx, `CREATE TABLE half_done (x TEXT)`); err != nil {
					return err
				}
				return boom
			},
		})
		if err := p.migrate(t.Context(), db); !errors.Is(err, boom) {
			t.Fatalf("migrate: %v, want the step's error", err)
		}
		if has, err := tableExists(t.Context(), db, "half_done"); err != nil || has {
			t.Fatalf("the failed step's table survived (err %v)", err)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM migrations WHERE name = '999_fails'`); n != 0 {
			t.Fatal("the failed step was recorded")
		}
	})
}

func TestFreshLibraryHasThePublishedSchema(t *testing.T) {
	forEachDriver(t, func(t *testing.T, d driver) {
		db := freshLibrary(t, d)
		assertPublishedSchema(t, db, "library.schema.sql")
	})
}

func TestLegacyLibraryMigratesToThePublishedSchema(t *testing.T) {
	forEachDriver(t, func(t *testing.T, d driver) {
		db := openFile(t, d)
		for _, stmt := range libraryBaseline {
			if strings.Contains(stmt, "library_attribution") || strings.Contains(stmt, "library_media") {
				continue
			}
			mustExec(t, db, stmt)
		}
		execScript(t, db, "legacy_library_attributions.sql")

		if err := MigrateLibrary(t.Context(), db); err != nil {
			t.Fatalf("migrate: %v", err)
		}
		assertPublishedSchema(t, db, "library.schema.sql")

		got := queryStrings(t, db, `SELECT id || ' ' || kind FROM library_attributions ORDER BY id`)
		if strings.Join(got, ",") != "canonical_a pinned,canonical_b boost" {
			t.Fatalf("attribution kinds: %v", got)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM library_attribution_triggers`); n != 2 {
			t.Fatalf("the kind rebuild lost trigger rows: %d left", n)
		}
		if n := queryInt(t, db, `SELECT COUNT(*) FROM library_attribution_refs`); n != 2 {
			t.Fatalf("the ref rebuild lost rows: %d left", n)
		}
		if err := MigrateLibrary(t.Context(), db); err != nil {
			t.Fatalf("second migrate: %v", err)
		}
		assertPublishedSchema(t, db, "library.schema.sql")
	})
}
