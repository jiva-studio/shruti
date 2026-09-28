package catalogdb

import (
	"database/sql"
	"sort"
	"strings"
	"testing"
)

func TestFoldSearchText(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"cyrillic stress", "Кри́шна", "Кришна"},
		{"decomposed short i", "Настро" + "й" + "ка", "Настройка"},
		{"precomposed cyrillic", "Настройка їжа Ґанді", "Настройка їжа Ґанді"},
		{"yo", "учёные", "ученые"},
		{"latin macron", "Bhagavad-gītā", "Bhagavad-gita"},
		{"dotted capital i", "İSKCON", "ISKCON"},
		{"devanagari", "कृष्ण", "कषण"},
		{"bengali", "কৃষ্ণ", "কষণ"},
	} {
		if got := FoldSearchText(tc.in); got != tc.want {
			t.Errorf("%s: FoldSearchText(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

// seedSearchTrack stores one track with two variants, a reference, a location
// and a kind tag.
func seedSearchTrack(t *testing.T, db *sql.DB) {
	t.Helper()
	mustExec(t, db, `INSERT INTO tracks (id, date, location_id) VALUES ('track_abc', '1974-06-22', 'location_bombay')`)
	mustExec(t, db, `INSERT INTO locations (id, language, full_name) VALUES
		('location_bombay', 'en', 'Bombay'), ('location_bombay', 'ru', 'Бомбей')`)
	mustExec(t, db, `INSERT INTO track_tags (track_id, tag_id) VALUES ('track_abc', 'tag_morning_walk')`)
	mustExec(t, db, `INSERT INTO track_variants (track_id, language, title) VALUES
		('track_abc', 'en', 'Life After Death'), ('track_abc', 'ru', 'Жизнь после смерти')`)
	mustExec(t, db, `INSERT INTO track_references (track_id, ref_idx, source_id, tokens)
		VALUES ('track_abc', 0, 'source_bg', '2.13')`)
	mustExec(t, db, `INSERT INTO sources (id, language, full_name, short_name) VALUES
		('source_bg', 'en', 'Bhagavad-gita', 'BG'), ('source_bg', 'ru', 'Бхагавад-гита', 'БГ')`)
}

func reindex(t *testing.T, db *sql.DB, trackID string) {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := ReindexTrackSearch(t.Context(), tx, trackID); err != nil {
		t.Fatalf("reindex: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestReindexTrackSearchIndexesEverySearchableToken(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		seedSearchTrack(t, db)
		reindex(t, db, "track_abc")
		reindex(t, db, "track_abc")

		titles := queryStrings(t, db, `SELECT content FROM tracks_search WHERE track_id = 'track_abc' AND kind = 'title'`)
		sort.Strings(titles)
		if strings.Join(titles, "|") != "Life After Death|Жизнь после смерти" {
			t.Fatalf("title rows: %v", titles)
		}
		combined := queryStrings(t, db, `SELECT content FROM tracks_search WHERE track_id = 'track_abc' AND kind = 'combined'`)
		if len(combined) != 1 {
			t.Fatalf("%d combined rows, want exactly one", len(combined))
		}
		for _, needle := range []string{
			"Life After Death", "Жизнь после смерти", "source_bg 2.13", "BG 2.13", "Bhagavad-gita 2.13",
			"БГ 2.13", "Бхагавад-гита 2.13", "Bombay", "Бомбей", "Morning Walk", "Утренняя прогулка",
			"1974", "1974-06", "1974-06-22",
		} {
			if !strings.Contains(combined[0], needle) {
				t.Errorf("combined row lacks %q: %q", needle, combined[0])
			}
		}
		for _, q := range []string{
			`bg*`, `2* 13*`, `bg* 1974* 2* 13*`, `"Bhagavad-gita"*`, `бомбей*`, `bombay* bg*`,
			`утренняя* прогулка*`, `"1974-06"*`,
		} {
			got := queryStrings(t, db,
				`SELECT track_id FROM tracks_search WHERE tracks_search MATCH ? AND kind = 'combined'`, q)
			if len(got) != 1 || got[0] != "track_abc" {
				t.Errorf("MATCH %q found %v", q, got)
			}
		}
	})
}

func TestReindexTrackSearchFoldsTitles(t *testing.T) {
	catalogWriter(t, func(t *testing.T, d driver) {
		db := freshCatalog(t, d)
		seedSearchTrack(t, db)
		mustExec(t, db, `UPDATE track_variants SET title = 'Кришна пришёл как कृष्ण' WHERE language = 'ru'`)
		reindex(t, db, "track_abc")
		for _, q := range []string{`кришна* пришел*`, `कषण*`} {
			got := queryStrings(t, db,
				`SELECT track_id FROM tracks_search WHERE tracks_search MATCH ? AND kind = 'combined'`, q)
			if len(got) != 1 {
				t.Errorf("MATCH %q found %v", q, got)
			}
		}
	})
}
