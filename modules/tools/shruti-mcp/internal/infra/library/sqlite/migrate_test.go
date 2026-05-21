package sqlitelibrary

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestApplyLocalMigrations_FromEmpty(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}

	want := []string{
		"library_attributions",
		"library_attribution_texts",
		"library_attribution_refs",
	}
	for _, name := range want {
		var n int
		row := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", name)
		if err := row.Scan(&n); err != nil {
			t.Fatalf("query table %s: %v", name, err)
		}
		if n != 1 {
			t.Fatalf("table %s missing (count=%d)", name, n)
		}
	}
}

func TestApplyLocalMigrations_Idempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	for i := 0; i < 3; i++ {
		if err := applyLocalMigrations(ctx, db); err != nil {
			t.Fatalf("apply pass %d: %v", i, err)
		}
	}
}

func TestApplyLocalMigrations_OnExistingLibraryDB(t *testing.T) {
	// Simulate a library.db that has verses/documents but never saw
	// attribution-tables. Migration must add them without touching the
	// existing read-only data.
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	// Pre-create a verses table with one row.
	if _, err := db.ExecContext(ctx, `CREATE TABLE library_verses (id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT)`); err != nil {
		t.Fatalf("seed verses: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO library_verses (id, source_id, tokens) VALUES ('verse_x', 'source_BG', '2.13')`); err != nil {
		t.Fatalf("insert verse: %v", err)
	}

	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// Existing data still present.
	var srcID string
	row := db.QueryRowContext(ctx, "SELECT source_id FROM library_verses WHERE id='verse_x'")
	if err := row.Scan(&srcID); err != nil {
		t.Fatalf("read verse: %v", err)
	}
	if srcID != "source_BG" {
		t.Fatalf("verse mutated: %q", srcID)
	}

	// New tables exist.
	var n int
	row = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='library_attributions'")
	if err := row.Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Fatalf("attributions table missing")
	}
}

func TestApplyLocalMigrations_KindCheckConstraint(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// Valid kinds OK.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_q", "question", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("insert question: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_t", "topic", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("insert topic: %v", err)
	}
	// Invalid kind rejected.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_x", "invalid", "2026-05-21", "2026-05-21"); err == nil {
		t.Fatalf("expected CHECK constraint violation, got nil")
	}
}

func TestApplyLocalMigrations_CascadeDelete(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}
	// Seed parent + child rows.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_q", "question", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("insert parent: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attribution_texts (attribution_id, language, text) VALUES (?,?,?)`,
		"attribution_q", "ru", "что такое разум"); err != nil {
		t.Fatalf("insert text: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id) VALUES (?,?,?)`,
		"attribution_q", "verse", "verse_xyz"); err != nil {
		t.Fatalf("insert ref: %v", err)
	}
	// Delete parent, expect cascade.
	if _, err := db.ExecContext(ctx, `DELETE FROM library_attributions WHERE id='attribution_q'`); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var n int
	row := db.QueryRowContext(ctx, "SELECT count(*) FROM library_attribution_texts WHERE attribution_id='attribution_q'")
	if err := row.Scan(&n); err != nil {
		t.Fatalf("query texts: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected cascade delete of texts (got %d rows)", n)
	}
	row = db.QueryRowContext(ctx, "SELECT count(*) FROM library_attribution_refs WHERE attribution_id='attribution_q'")
	if err := row.Scan(&n); err != nil {
		t.Fatalf("query refs: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected cascade delete of refs (got %d rows)", n)
	}
}
