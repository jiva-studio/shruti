package sqlitecatalog

import (
	"database/sql"
	"sort"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// TestRebuildTrackSearchRows verifies that a single rebuild for one track
// produces both the per-variant `title` rows and the unified `combined`
// row that ANDs across title, every reference variant (source_id /
// short_name / full_name), and the year. This is what mobile search
// matches against — without these rows the multi-token query path
// returns nothing.
func TestRebuildTrackSearchRows(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	ctx := t.Context()
	setupFtsSchema(t, db)
	seedFixture(t, db)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM tracks_search WHERE track_id = ?`, "track_abc"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := rebuildTrackSearchRows(ctx, tx, "track_abc"); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	titles := readKind(t, db, "track_abc", "title")
	sort.Strings(titles)
	wantTitles := []string{"Life After Death", "Жизнь после смерти"}
	sort.Strings(wantTitles)
	if !equal(titles, wantTitles) {
		t.Errorf("title rows: got %v, want %v", titles, wantTitles)
	}

	combined := readKind(t, db, "track_abc", "combined")
	if len(combined) != 1 {
		t.Fatalf("expected exactly one combined row, got %d: %v", len(combined), combined)
	}
	got := combined[0]
	for _, needle := range []string{
		"Life After Death",
		"Жизнь после смерти",
		"source_bg",
		"BG 2.13",
		"Bhagavad-gita 2.13",
		"БГ 2.13",
		"Бхагавад-гита 2.13",
		"Bombay",
		"Бомбей",
		"Morning Walk",
		"Утренняя прогулка",
		"1974",
		"1974-06",
		"1974-06-22",
	} {
		if !strings.Contains(got, needle) {
			t.Errorf("combined missing %q; got %q", needle, got)
		}
	}
}

// TestRebuildTrackSearchRowsAndQuery walks the mobile search join: a
// multi-token implicit-AND prefix MATCH against `kind = 'combined'`
// returns the seeded track for source-only, year-only, ref-only, and
// combined queries.
func TestRebuildTrackSearchRowsAndQuery(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := t.Context()
	setupFtsSchema(t, db)
	seedFixture(t, db)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := rebuildTrackSearchRows(ctx, tx, "track_abc"); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	cases := []struct{ q string }{
		{`bg*`},
		{`2* 13*`},
		{`1974*`},
		{`bg* 1974* 2* 13*`},
		{`"Bhagavad-gita"*`},
		{`bombay*`},
		{`бомбей*`},
		{`bombay* bg*`},
		{`morning* walk*`},
		{`утренняя* прогулка*`},
		{`"1974-06"*`},
	}
	for _, c := range cases {
		t.Run(c.q, func(t *testing.T) {
			var trackID string
			row := db.QueryRowContext(ctx, `
				SELECT track_id FROM tracks_search
				WHERE tracks_search MATCH ? AND kind = 'combined'`, c.q)
			if err := row.Scan(&trackID); err != nil {
				t.Fatalf("query %q: %v", c.q, err)
			}
			if trackID != "track_abc" {
				t.Errorf("query %q: got track_id=%q, want track_abc", c.q, trackID)
			}
		})
	}
}

func setupFtsSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE tracks (
			id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
			date TEXT, hidden INTEGER DEFAULT 0)`,
		`CREATE TABLE track_variants (
			track_id TEXT, language TEXT, title TEXT,
			audio_path TEXT, audio_filesize INTEGER, audio_duration INTEGER,
			audio_kind TEXT, transcript_path TEXT, transcript_kind TEXT,
			sort_reference TEXT,
			PRIMARY KEY (track_id, language))`,
		`CREATE TABLE track_references (
			track_id TEXT, ref_idx INTEGER, source_id TEXT, tokens TEXT,
			PRIMARY KEY (track_id, ref_idx))`,
		`CREATE TABLE sources (
			id TEXT, language TEXT, full_name TEXT, short_name TEXT,
			PRIMARY KEY (id, language))`,
		`CREATE TABLE locations (
			id TEXT, language TEXT, full_name TEXT,
			PRIMARY KEY (id, language))`,
		`CREATE TABLE tags (
			id TEXT, language TEXT, full_name TEXT,
			PRIMARY KEY (id, language))`,
		`CREATE TABLE track_tags (
			track_id TEXT, tag_id TEXT,
			PRIMARY KEY (track_id, tag_id))`,
		`CREATE VIRTUAL TABLE tracks_search USING fts4(
			content, track_id, kind,
			notindexed="track_id", notindexed="kind",
			tokenize=unicode61 "remove_diacritics=2")`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("schema: %s: %v", s, err)
		}
	}
}

func seedFixture(t *testing.T, db *sql.DB) {
	t.Helper()
	exec(t, db,
		`INSERT INTO tracks (id, date, location_id) VALUES ('track_abc', '1974-06-22', 'location_bombay')`)
	exec(t, db,
		`INSERT INTO locations (id, language, full_name) VALUES
		 ('location_bombay', 'en', 'Bombay'),
		 ('location_bombay', 'ru', 'Бомбей')`)
	exec(t, db,
		`INSERT INTO tags (id, language, full_name) VALUES
		 ('tag_morning_walk', 'en', 'Morning Walk'),
		 ('tag_morning_walk', 'ru', 'Утренняя прогулка')`)
	exec(t, db,
		`INSERT INTO track_tags (track_id, tag_id) VALUES
		 ('track_abc', 'tag_morning_walk')`)
	exec(t, db,
		`INSERT INTO track_variants (track_id, language, title) VALUES
		 ('track_abc', 'en', 'Life After Death'),
		 ('track_abc', 'ru', 'Жизнь после смерти')`)
	exec(t, db,
		`INSERT INTO track_references (track_id, ref_idx, source_id, tokens)
		 VALUES ('track_abc', 0, 'source_bg', '2.13')`)
	exec(t, db,
		`INSERT INTO sources (id, language, full_name, short_name) VALUES
		 ('source_bg', 'en', 'Bhagavad-gita', 'BG'),
		 ('source_bg', 'ru', 'Бхагавад-гита', 'БГ')`)
}

func exec(t *testing.T, db *sql.DB, q string) {
	t.Helper()
	if _, err := db.Exec(q); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

func readKind(t *testing.T, db *sql.DB, trackID, kind string) []string {
	t.Helper()
	rows, err := db.Query(
		`SELECT content FROM tracks_search WHERE track_id = ? AND kind = ?`,
		trackID, kind)
	if err != nil {
		t.Fatalf("read %s: %v", kind, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read %s: %v", kind, err)
	}
	return out
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
