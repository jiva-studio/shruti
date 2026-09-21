package sqlitelibrary

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenRW_AutoCreates(t *testing.T) {
	ctx := t.Context()
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "library.db")
	l := NewLazy(path)

	r, err := l.openRW(ctx)
	if err != nil {
		t.Fatalf("openRW: %v", err)
	}
	defer r.Close()

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}

	// Migrations should have run — verify attribution tables exist.
	var n int
	row := r.db.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='library_attributions'")
	if err := row.Scan(&n); err != nil {
		t.Fatalf("query: %v", err)
	}
	if n != 1 {
		t.Fatalf("attributions table missing after openRW")
	}
}

func TestOpenRO_FailsOnMissing(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "absent.db")
	l := NewLazy(path)

	_, err := l.openRO(ctx)
	if err == nil {
		t.Fatalf("expected error for missing library.db, got nil")
	}
}
