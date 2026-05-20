package sqlitecatalog

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

// setupPackSchema applies just what the pack tests need: the two pack
// tables (via ensurePackTables, the same path the live binary uses) and
// a minimal track + track_variants schema so the language-mismatch
// invariant can be tested end-to-end.
func setupPackSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	// Minimal track-side schema; FK enforcement off to keep the fixture small.
	// `migrations` is part of the canonical catalog schema (carries the
	// 001_init_schema / 002_drop_sort_cache rows in production) — recreated
	// here so the pack migration can INSERT its row.
	stmts := []string{
		`CREATE TABLE tracks (
			id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
			date TEXT, hidden INTEGER DEFAULT 0)`,
		`CREATE TABLE track_variants (
			track_id TEXT, language TEXT, title TEXT,
			PRIMARY KEY (track_id, language))`,
		`CREATE TABLE migrations (
			name       TEXT PRIMARY KEY,
			scheme     INTEGER,
			applied_at INTEGER NOT NULL)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("setup: %s: %v", s, err)
		}
	}
	if err := ensurePackTables(context.Background(), db); err != nil {
		t.Fatalf("ensurePackTables: %v", err)
	}
}

func newPackTestRepo(t *testing.T) (*Repo, func()) {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	setupPackSchema(t, db)
	r := &Repo{db: db, path: ":memory:"}
	return r, func() { _ = db.Close() }
}

func seedTrackVariant(t *testing.T, db *sql.DB, trackID, language string) {
	t.Helper()
	if _, err := db.Exec(`INSERT OR IGNORE INTO tracks (id) VALUES (?)`, trackID); err != nil {
		t.Fatalf("seed track: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO track_variants (track_id, language, title) VALUES (?, ?, ?)`,
		trackID, language, "t"); err != nil {
		t.Fatalf("seed variant: %v", err)
	}
}

func TestPackCRUDLifecycle(t *testing.T) {
	r, done := newPackTestRepo(t)
	defer done()
	ctx := context.Background()

	const packID = "pack_AbCdEfGhIjKl"

	// Create RU + EN locales for the same logical pack.
	if err := r.CreatePackLocale(ctx, packID, "ru", "Лекции о карме", true, 10); err != nil {
		t.Fatalf("create ru: %v", err)
	}
	if err := r.CreatePackLocale(ctx, packID, "en", "Lectures on karma", true, 10); err != nil {
		t.Fatalf("create en: %v", err)
	}

	// Get: should collapse both locales.
	pack, tracksByLang, ok, err := r.GetPack(ctx, packID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatal("get: not found")
	}
	if pack.Names["ru"] != "Лекции о карме" || pack.Names["en"] != "Lectures on karma" {
		t.Errorf("names mismatch: %#v", pack.Names)
	}
	if !pack.Featured["ru"] || !pack.Featured["en"] {
		t.Errorf("featured mismatch: %#v", pack.Featured)
	}
	if len(tracksByLang["ru"]) != 0 || len(tracksByLang["en"]) != 0 {
		t.Errorf("expected empty track lists, got %#v", tracksByLang)
	}

	// Update one locale.
	newName := "Лекции о карме и судьбе"
	if err := r.UpdatePackLocale(ctx, packID, "ru", &newName, nil, nil); err != nil {
		t.Fatalf("update: %v", err)
	}
	pack, _, _, _ = r.GetPack(ctx, packID)
	if pack.Names["ru"] != newName {
		t.Errorf("after update, ru name = %q want %q", pack.Names["ru"], newName)
	}

	// Seed three RU tracks + populate pack_tracks via SetPackTracks.
	for _, tid := range []string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"} {
		seedTrackVariant(t, r.db, tid, "ru")
	}
	if err := r.SetPackTracks(ctx, packID, "ru",
		[]string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"}); err != nil {
		t.Fatalf("set tracks: %v", err)
	}

	_, tracksByLang, _, _ = r.GetPack(ctx, packID)
	got := tracksByLang["ru"]
	want := []string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"}
	if len(got) != len(want) {
		t.Fatalf("after set: got %d tracks, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("position[%d]: got %q want %q", i, got[i], want[i])
		}
	}

	// Add one track at position 1 — should shift bb and cc one step right.
	seedTrackVariant(t, r.db, "track_dddddddddddd", "ru")
	pos := 1
	if err := r.AddPackTrack(ctx, packID, "ru", "track_dddddddddddd", &pos); err != nil {
		t.Fatalf("add: %v", err)
	}
	_, tracksByLang, _, _ = r.GetPack(ctx, packID)
	want = []string{"track_aaaaaaaaaaaa", "track_dddddddddddd", "track_bbbbbbbbbbbb", "track_cccccccccccc"}
	got = tracksByLang["ru"]
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("after add: position[%d] = %q want %q", i, got[i], want[i])
		}
	}

	// Idempotent re-add: count stays the same.
	if err := r.AddPackTrack(ctx, packID, "ru", "track_dddddddddddd", nil); err != nil {
		t.Fatalf("re-add: %v", err)
	}
	_, tracksByLang, _, _ = r.GetPack(ctx, packID)
	if len(tracksByLang["ru"]) != 4 {
		t.Errorf("re-add changed length to %d (want 4)", len(tracksByLang["ru"]))
	}

	// Remove the middle track — sequence should compact (no gaps).
	if err := r.RemovePackTrack(ctx, packID, "ru", "track_dddddddddddd"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	_, tracksByLang, _, _ = r.GetPack(ctx, packID)
	want = []string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"}
	got = tracksByLang["ru"]
	if len(got) != 3 {
		t.Fatalf("after remove: %d tracks, want 3", len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("after remove: pos[%d] = %q want %q", i, got[i], want[i])
		}
	}

	// List with filter.
	ru := "ru"
	featured := true
	packs, err := r.ListPacks(ctx, catalog.PackListOpts{Language: &ru, Featured: &featured})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(packs) != 1 || packs[0].Id != packID {
		t.Errorf("list: %#v", packs)
	}

	// Delete the EN locale only — RU + its tracks survive.
	if err := r.DeletePackLocale(ctx, packID, "en"); err != nil {
		t.Fatalf("delete_locale: %v", err)
	}
	pack, _, _, _ = r.GetPack(ctx, packID)
	if _, ok := pack.Names["en"]; ok {
		t.Errorf("en locale should be gone, got %#v", pack.Names)
	}
	if pack.Names["ru"] == "" {
		t.Errorf("ru locale should survive, got %#v", pack.Names)
	}

	// Full delete: cascades pack_tracks.
	if err := r.DeletePack(ctx, packID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, _, ok, err = r.GetPack(ctx, packID)
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	if ok {
		t.Errorf("get should be not-found after delete")
	}
	var leftover int
	row := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pack_tracks WHERE pack_id = ?`, packID)
	if err := row.Scan(&leftover); err != nil {
		t.Fatalf("count pack_tracks: %v", err)
	}
	if leftover != 0 {
		t.Errorf("FK cascade left %d pack_tracks rows", leftover)
	}
}

func TestEnsurePackTablesIsIdempotent(t *testing.T) {
	r, done := newPackTestRepo(t)
	defer done()
	// newPackTestRepo already invoked ensurePackTables once via setup;
	// a second call must remain a no-op.
	if err := ensurePackTables(context.Background(), r.db); err != nil {
		t.Fatalf("second call (idempotent): %v", err)
	}
}

func TestPackTrackLanguagesMismatch(t *testing.T) {
	r, done := newPackTestRepo(t)
	defer done()
	ctx := context.Background()

	// EN-only track: has no ru variant.
	seedTrackVariant(t, r.db, "track_enonly000000ab", "en")

	langs, err := r.TrackLanguages(ctx, "track_enonly000000ab")
	if err != nil {
		t.Fatalf("TrackLanguages: %v", err)
	}
	if len(langs) != 1 || langs[0] != "en" {
		t.Errorf("expected [en], got %v", langs)
	}
}
