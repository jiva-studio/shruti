package sqlitecatalog

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// TestRebuildTrackSearchRowsFoldsYo pins the index half of #1629: a title
// spelled with `ё` must be indexed under `е`, because that is the spelling
// the mobile query builder sends for either form.
func TestRebuildTrackSearchRowsFoldsYo(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	setupFtsSchema(t, db)
	seedFixture(t, db)
	exec(t, db,
		`UPDATE track_variants SET title = 'Кришна пришёл как имя' WHERE track_id = 'track_abc' AND language = 'ru'`)

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

	combined := readKind(t, db, "track_abc", "combined")
	if len(combined) != 1 {
		t.Fatalf("expected one combined row, got %d", len(combined))
	}
	if strings.Contains(combined[0], "ё") {
		t.Errorf("combined row still carries ё: %q", combined[0])
	}
	for _, q := range []string{`кришна* пришел*`, `имя*`} {
		var trackID string
		row := db.QueryRowContext(ctx, `
			SELECT track_id FROM tracks_search
			WHERE tracks_search MATCH ? AND kind = 'combined'`, q)
		if err := row.Scan(&trackID); err != nil {
			t.Fatalf("query %q: %v", q, err)
		}
	}
}

// TestFoldExistingFtsRows covers a current.db published before the writer
// folded: the rows already on disk are rewritten in place, and the run is
// idempotent and scheme-neutral (the mobile validator reads the newest
// non-NULL scheme, which this migration must not move).
func TestFoldExistingFtsRows(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	setupFtsSchema(t, db)
	exec(t, db, `CREATE TABLE migrations (
		name TEXT PRIMARY KEY, scheme INTEGER, applied_at INTEGER NOT NULL)`)
	exec(t, db, `INSERT INTO migrations (name, scheme, applied_at)
		VALUES ('006_add_settings_and_daily_wisdom', 20260621, 1)`)
	exec(t, db, `INSERT INTO tracks_search (content, track_id, kind)
		VALUES ('Кришна пришёл как имя', 'track_abc', 'combined')`)

	if err := foldExistingFtsRows(ctx, db); err != nil {
		t.Fatalf("fold: %v", err)
	}

	var trackID string
	row := db.QueryRowContext(ctx, `
		SELECT track_id FROM tracks_search
		WHERE tracks_search MATCH 'кришна* пришел*' AND kind = 'combined'`)
	if err := row.Scan(&trackID); err != nil {
		t.Fatalf("query folded row: %v", err)
	}

	var scheme int
	if err := db.QueryRowContext(ctx,
		`SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1`).
		Scan(&scheme); err != nil {
		t.Fatalf("read scheme: %v", err)
	}
	if scheme != 20260621 {
		t.Errorf("scheme moved to %d", scheme)
	}

	if err := foldExistingFtsRows(ctx, db); err != nil {
		t.Fatalf("second fold: %v", err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tracks_search`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("row count = %d, want 1", n)
	}
}
