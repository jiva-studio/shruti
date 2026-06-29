package sqlitelibrary

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// TestLazy_AttributionRoundTrip exercises the full MCP write/read cycle
// over `Lazy`: each call opens its own connection, performs one op, closes.
// This mirrors how MCP tool handlers use the daemon's *Lazy — one handler
// invocation = one open/close pair.
//
// Verifies:
//   - openRW auto-creates library.db on a clean dir (no pre-import needed)
//   - applyLocalMigrations runs on every Open and is idempotent across
//     repeated open/close cycles
//   - data persists across connections (no in-memory weirdness)
//   - the repo's cross-call invariants (e.g. AttributionDelete cascading)
//     hold when each call is its own connection
func TestLazy_AttributionRoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	l := NewLazy(path)

	// First op: create an attribution. openRW auto-creates the file.
	if err := l.AttributionCreate(
		ctx, "attribution_xyz", library.AttrPinned, "ru", "что такое разум",
	); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Subsequent op: add a text variant via a fresh connection.
	if err := l.AttributionTextAdd(
		ctx, "attribution_xyz", "ru", "природа разума",
	); err != nil {
		t.Fatalf("text_add: %v", err)
	}

	// Read via openRO — separate connection again.
	got, ok, err := l.AttributionGet(ctx, "attribution_xyz")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.Kind != library.AttrPinned {
		t.Fatalf("kind mismatch: %v", got.Kind)
	}
	if len(got.Texts["ru"]) != 2 {
		t.Fatalf("expected 2 ru variants, got %d: %v", len(got.Texts["ru"]), got.Texts["ru"])
	}

	// List filtering still works across connections.
	items, err := l.AttributionList(ctx, library.ListAttributionsOpts{
		Kind: library.AttrPinned,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("expected 1 question attribution, got %d", len(items))
	}

	// Delete: cascade removes texts via FK ON DELETE CASCADE — verify
	// across a fresh connection.
	if err := l.AttributionDelete(ctx, "attribution_xyz"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, ok, _ = l.AttributionGet(ctx, "attribution_xyz")
	if ok {
		t.Fatalf("expected attribution gone after delete")
	}
}

// TestLazy_LegacyReadOpenStillWorks: existing read-only handlers
// (GetVerse, ListVerses, ...) shouldn't have regressed after the
// migrate.go / lazy split. This recreates the pre-feature data shape
// (verses + variants but NO attribution rows) and exercises the
// established read path.
func TestLazy_LegacyReadOpenStillWorks(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	// openRW once to create + migrate.
	l := NewLazy(path)
	if err := l.AttributionCreate(
		ctx, "attribution_x", library.AttrBoost, "ru", "x",
	); err != nil {
		t.Fatalf("seed via RW: %v", err)
	}

	// Manually seed legacy verse data.
	r, err := l.openRO(ctx)
	if err != nil {
		t.Fatalf("openRO: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS library_verses (
			id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT,
			text TEXT, transliteration TEXT
		)`); err != nil {
		t.Fatalf("ensure verses table: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS library_verse_variants (
			verse_id TEXT, language TEXT, translation TEXT,
			PRIMARY KEY (verse_id, language)
		)`); err != nil {
		t.Fatalf("ensure variants table: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO library_verses (id, source_id, tokens, text, transliteration) VALUES (?,?,?,?,?)`,
		"verse_x", "source_BG", "2.13", "devanagari text", "iast"); err != nil {
		t.Fatalf("insert verse: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO library_verse_variants (verse_id, language, translation) VALUES (?,?,?)`,
		"verse_x", "ru", "перевод"); err != nil {
		t.Fatalf("insert variant: %v", err)
	}
	r.Close()

	// Read via legacy path — should work unchanged.
	v, ok, err := l.GetVerse(ctx, "source_BG", "2.13")
	if err != nil || !ok {
		t.Fatalf("GetVerse: ok=%v err=%v", ok, err)
	}
	if v.ID != "verse_x" || v.Translations["ru"] != "перевод" {
		t.Fatalf("verse data wrong: %+v", v)
	}
}
