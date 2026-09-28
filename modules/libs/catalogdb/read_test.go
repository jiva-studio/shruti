package catalogdb

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
)

// publishedFile writes a migrated, seeded file with the catalog writer and
// returns its path, so each driver can then read it the way a service reads a
// downloaded catalog.
func publishedFile(t *testing.T, migrate func(*testing.T, *sql.DB), seed ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "published.db")
	db, err := sql.Open(drivers[0].sql, drivers[0].dsn(path))
	if err != nil {
		t.Fatal(err)
	}
	migrate(t, db)
	for _, s := range seed {
		mustExec(t, db, s)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func openReadOnly(t *testing.T, d driver, path string) *sql.DB {
	t.Helper()
	dsn := "file:" + path + "?mode=ro"
	db, err := sql.Open(d.sql, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return db
}

func migrateCatalog(t *testing.T, db *sql.DB) {
	t.Helper()
	if err := MigrateCatalog(t.Context(), db); err != nil {
		t.Fatal(err)
	}
}

func migrateLibrary(t *testing.T, db *sql.DB) {
	t.Helper()
	if err := MigrateLibrary(t.Context(), db); err != nil {
		t.Fatal(err)
	}
}

func TestCatalogReads(t *testing.T) {
	path := publishedFile(t, migrateCatalog,
		`INSERT INTO tracks (id, author_id, location_id, date, hidden, contributor_user_id) VALUES
			('t1', 'author_a', 'loc_a', '1974-01-01', 0, NULL),
			('t2', NULL, NULL, NULL, 1, 'user_x')`,
		`INSERT INTO track_variants (track_id, language, title, transcript_path, outline) VALUES
			('t1', 'ru', 'Один', 'public/tracks/t1/transcripts/ru.json', '[]'),
			('t1', 'en', 'One', NULL, NULL),
			('t2', 'en', 'Two', NULL, NULL)`,
		`INSERT INTO track_audio (track_id, language, kind, path, duration) VALUES
			('t1', 'ru', 'original', 'a.mp3', 1000), ('t1', 'ru', 'clean', 'b.mp3', 1200)`,
		`INSERT INTO track_tags (track_id, tag_id) VALUES ('t1', 'tag_interview'), ('t1', 'tag_bhajan')`,
		`INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES
			('t1', 1, 'source_bg', '2.13'), ('t1', 0, 'source_sb', '5.5.3'), ('t2', 0, 'source_bg', '2')`,
		`INSERT INTO sources (id, language, full_name, short_name) VALUES ('source_bg', 'en', 'Bhagavad-gita', 'BG')`,
	)
	forEachDriver(t, func(t *testing.T, d driver) {
		ctx, db := t.Context(), openReadOnly(t, d, path)

		track, ok, err := TrackByID(ctx, db, "t2")
		if err != nil || !ok {
			t.Fatalf("TrackByID: %v %v", ok, err)
		}
		if want := (Track{ID: "t2", Hidden: true, ContributorUserID: "user_x"}); track != want {
			t.Fatalf("TrackByID = %+v, want %+v", track, want)
		}
		if _, ok, err := TrackByID(ctx, db, "missing"); ok || err != nil {
			t.Fatalf("missing track: %v %v", ok, err)
		}

		ids := []string{"t1", "t2", "missing"}
		variants, err := VariantsOf(ctx, db, ids)
		if err != nil {
			t.Fatal(err)
		}
		if got := variants["t1"]; len(got) != 2 || got[0].Language != "en" || got[1].TranscriptPath != "public/tracks/t1/transcripts/ru.json" || got[1].Outline != "[]" {
			t.Fatalf("variants of t1: %+v", got)
		}
		durations, err := AudioDurationsOf(ctx, db, ids)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(durations, map[string]map[string]int64{"t1": {"ru": 1200}}) {
			t.Fatalf("durations: %v", durations)
		}
		tags, err := TagsOf(ctx, db, ids)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(tags, map[string][]string{"t1": {"tag_bhajan", "tag_interview"}}) {
			t.Fatalf("tags: %v", tags)
		}
		refs, err := ReferencesOf(ctx, db, ids)
		if err != nil {
			t.Fatal(err)
		}
		if got := refs["t1"]; len(got) != 2 || got[0] != (Reference{"source_sb", "5.5.3"}) {
			t.Fatalf("references keep ref_idx order: %v", got)
		}
		citing, err := TrackIDsCiting(ctx, db, "source_bg", "2")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(citing, []string{"t1", "t2"}) {
			t.Fatalf("chapter 2 is cited by %v", citing)
		}
		sources, err := DictRows(ctx, db, DictSources)
		if err != nil {
			t.Fatal(err)
		}
		if len(sources) != 1 || sources[0] != (DictRow{"source_bg", "en", "Bhagavad-gita", "BG"}) {
			t.Fatalf("sources: %v", sources)
		}
		if _, err := DictRows(ctx, db, Dict("tracks")); err == nil {
			t.Fatal("DictRows read a table that is not a dictionary")
		}
		scheme, err := ReadScheme(ctx, db)
		if err != nil || scheme != Scheme {
			t.Fatalf("ReadScheme = %d, %v", scheme, err)
		}
	})
}

func TestVariantsOfCrossesTheChunkBoundary(t *testing.T) {
	seed := []string{}
	ids := make([]string, 0, maxChunk+3)
	for i := range maxChunk + 3 {
		id := "t" + string(rune('a'+i%26)) + string(rune('a'+i/26%26)) + string(rune('a'+i/676))
		ids = append(ids, id)
		seed = append(seed, `INSERT INTO track_variants (track_id, language, title) VALUES ('`+id+`', 'en', 'x')`)
	}
	path := publishedFile(t, migrateCatalog, seed...)
	db := openReadOnly(t, drivers[1], path)
	got, err := VariantsOf(t.Context(), db, ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(ids) {
		t.Fatalf("%d tracks read back, want %d", len(got), len(ids))
	}
}

func TestLibraryReads(t *testing.T) {
	path := publishedFile(t, migrateLibrary,
		`INSERT INTO library_verses (id, source_id, tokens, text, transliteration) VALUES
			('v1', 'source_bg', '1.16', 'block', 'iast'),
			('v2', 'source_bg', '1.17', 'block', 'iast'),
			('v3', 'source_bg', '2.13', 'other', NULL)`,
		`INSERT INTO library_verse_translations (id, verse_id, language, translation, kind, author_id) VALUES
			('tr1', 'v3', 'en', 'canonical text', 'canonical', NULL),
			('tr2', 'v3', 'en', 'alt text', 'alt', 'author_b')`,
		`INSERT INTO library_verse_transliterations (verse_id, language, text) VALUES ('v3', 'ru', 'кир')`,
		`INSERT INTO library_verse_words (id, translation_id, sort_order, surface_form, surface_translation) VALUES
			('w2', 'tr1', 2, 'b', 'B'), ('w1', 'tr1', 1, 'a', 'A')`,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES
			('attr1', 'memory', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')`,
		`INSERT INTO library_attribution_triggers (attribution_id, language, text) VALUES
			('attr1', 'ru', 'б'), ('attr1', 'ru', 'а')`,
		`INSERT INTO library_attribution_notes (attribution_id, language, note) VALUES ('attr1', 'en', 'note')`,
		`INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id, position, language) VALUES
			('attr1', 'track', 't1@0-1000', 1, 'ru'), ('attr1', 'verse', 'v3', 0, NULL)`,
	)
	forEachDriver(t, func(t *testing.T, d driver) {
		ctx, db := t.Context(), openReadOnly(t, d, path)

		v, ok, err := VerseAt(ctx, db, "source_bg", "2.13")
		if err != nil || !ok || v.ID != "v3" || v.Transliteration != "" {
			t.Fatalf("VerseAt = %+v %v %v", v, ok, err)
		}
		merged, err := VersesWithText(ctx, db, "source_bg", "block")
		if err != nil || len(merged) != 2 {
			t.Fatalf("VersesWithText = %v %v", merged, err)
		}
		chapter, err := VersesOf(ctx, db, "source_bg", "1")
		if err != nil || len(chapter) != 2 {
			t.Fatalf("VersesOf chapter 1 = %v %v", chapter, err)
		}
		canon, err := CanonicalTranslationsOf(ctx, db, []string{"v1", "v3"})
		if err != nil || !reflect.DeepEqual(canon, map[string]map[string]string{"v3": {"en": "canonical text"}}) {
			t.Fatalf("CanonicalTranslationsOf = %v %v", canon, err)
		}
		trs, err := TranslationsOf(ctx, db, "v3", "en")
		if err != nil || len(trs) != 2 || trs[0].Kind != "canonical" || trs[1].AuthorID != "author_b" {
			t.Fatalf("TranslationsOf = %+v %v", trs, err)
		}
		if tr, ok, err := TranslationOf(ctx, db, "v3", "en", "alt"); err != nil || !ok || tr.Text != "alt text" {
			t.Fatalf("TranslationOf = %+v %v %v", tr, ok, err)
		}
		if text, ok, err := TransliterationOf(ctx, db, "v3", "ru"); err != nil || !ok || text != "кир" {
			t.Fatalf("TransliterationOf = %q %v %v", text, ok, err)
		}
		words, err := WordsOf(ctx, db, "v3", "en", "canonical")
		if err != nil || !reflect.DeepEqual(words, []Word{{"a", "A"}, {"b", "B"}}) {
			t.Fatalf("WordsOf = %v %v", words, err)
		}

		a, ok, err := AttributionByID(ctx, db, "attr1")
		if err != nil || !ok {
			t.Fatalf("AttributionByID: %v %v", ok, err)
		}
		want := Attribution{
			ID: "attr1", Kind: "memory", CreatedAt: "2026-05-01T00:00:00Z", UpdatedAt: "2026-05-02T00:00:00Z",
			Triggers: map[string][]string{"ru": {"а", "б"}},
			Notes:    map[string]string{"en": "note"},
			Refs: []AttributionRef{
				{Kind: "verse", TargetID: "v3", Position: 0},
				{Kind: "track", TargetID: "t1@0-1000", Language: "ru", Position: 1},
			},
		}
		if !reflect.DeepEqual(a, want) {
			t.Fatalf("AttributionByID =\n%+v\nwant\n%+v", a, want)
		}
	})
}
