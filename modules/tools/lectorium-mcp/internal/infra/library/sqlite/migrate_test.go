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
		"attribution_q", "pinned", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("insert pinned: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_t", "boost", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("insert boost: %v", err)
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
		"attribution_q", "pinned", "2026-05-21", "2026-05-21"); err != nil {
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

// TestApplyLocalMigrations_KindRenamePinnedBoost seeds a legacy-shaped DB
// (the old CHECK (kind IN ('question','topic')) + rows with the old kinds and
// FK children) and asserts the migration remaps question→pinned / topic→boost,
// keeps the children, and installs the new CHECK — without cascade-deleting
// any children when the FK-parent table is rebuilt.
func TestApplyLocalMigrations_KindRenamePinnedBoost(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite3", "file:"+path+"?_foreign_keys=ON")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	// Build the legacy schema by hand (old CHECK).
	legacy := []string{
		`CREATE TABLE library_attributions (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('question', 'topic')),
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE library_attribution_texts (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			language TEXT NOT NULL,
			text TEXT NOT NULL,
			PRIMARY KEY (attribution_id, language, text)
		)`,
		`CREATE TABLE library_attribution_refs (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind TEXT NOT NULL,
			target_id TEXT NOT NULL,
			position INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (attribution_id, ref_kind, target_id)
		)`,
	}
	for _, s := range legacy {
		if _, err := db.ExecContext(ctx, s); err != nil {
			t.Fatalf("legacy ddl: %v", err)
		}
	}
	seed := [][]any{
		{"attribution_q", "question", "2026-05-21", "2026-05-21"},
		{"attribution_t", "topic", "2026-05-21", "2026-05-21"},
	}
	for _, r := range seed {
		if _, err := db.ExecContext(ctx,
			`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
			r...); err != nil {
			t.Fatalf("seed parent: %v", err)
		}
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attribution_texts (attribution_id, language, text) VALUES (?,?,?)`,
		"attribution_q", "ru", "что такое разум"); err != nil {
		t.Fatalf("seed text: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id) VALUES (?,?,?)`,
		"attribution_q", "verse", "verse_xyz"); err != nil {
		t.Fatalf("seed ref: %v", err)
	}

	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// Kinds remapped.
	var kind string
	if err := db.QueryRowContext(ctx, `SELECT kind FROM library_attributions WHERE id='attribution_q'`).Scan(&kind); err != nil {
		t.Fatalf("read q kind: %v", err)
	}
	if kind != "pinned" {
		t.Fatalf("question should map to pinned, got %q", kind)
	}
	if err := db.QueryRowContext(ctx, `SELECT kind FROM library_attributions WHERE id='attribution_t'`).Scan(&kind); err != nil {
		t.Fatalf("read t kind: %v", err)
	}
	if kind != "boost" {
		t.Fatalf("topic should map to boost, got %q", kind)
	}

	// Children survived the FK-parent rebuild (no cascade).
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM library_attribution_texts WHERE attribution_id='attribution_q'`).Scan(&n); err != nil {
		t.Fatalf("count texts: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected text to survive, got %d", n)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM library_attribution_refs WHERE attribution_id='attribution_q'`).Scan(&n); err != nil {
		t.Fatalf("count refs: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected ref to survive, got %d", n)
	}

	// New CHECK active: old kind rejected, new kind accepted.
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_old", "question", "2026-05-21", "2026-05-21"); err == nil {
		t.Fatalf("expected new CHECK to reject 'question'")
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		"attribution_new", "pinned", "2026-05-21", "2026-05-21"); err != nil {
		t.Fatalf("expected new CHECK to accept 'pinned': %v", err)
	}

	// Migration is idempotent — second run is a no-op.
	if err := applyLocalMigrations(ctx, db); err != nil {
		t.Fatalf("re-apply: %v", err)
	}
}
