package sqlitecatalog

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// setupCollectionSchema applies just what the collection tests need: the two collection
// tables (via ensureCollectionTables, the same path the live binary uses) and
// a minimal track + track_variants schema so the language-mismatch
// invariant can be tested end-to-end.
func setupCollectionSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	// Minimal track-side schema; FK enforcement off to keep the fixture small.
	// `migrations` is part of the canonical catalog schema (carries the
	// 001_init_schema / 002_drop_sort_cache rows in production) — recreated
	// here so the collection migration can INSERT its row.
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
	if err := ensureCollectionTables(context.Background(), db); err != nil {
		t.Fatalf("ensureCollectionTables: %v", err)
	}
}

func newCollectionTestRepo(t *testing.T) (*Repo, func()) {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	setupCollectionSchema(t, db)
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

// TestEnsureCollectionTablesRenamesLegacyPacks exercises the migration-on-open
// path: a current.db shipped before the rename carries `packs` / `pack_tracks`,
// and the first open under the new binary must rename them in place (preserving
// data + per-locale membership) and bump the migrations scheme row.
func TestEnsureCollectionTablesRenamesLegacyPacks(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()

	legacy := []string{
		`CREATE TABLE migrations (name TEXT PRIMARY KEY, scheme INTEGER, applied_at INTEGER NOT NULL)`,
		`CREATE TABLE packs (
			id TEXT NOT NULL, language TEXT NOT NULL, name TEXT NOT NULL,
			featured INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language))`,
		`CREATE TABLE pack_tracks (
			pack_id TEXT NOT NULL, pack_language TEXT NOT NULL, track_id TEXT NOT NULL,
			position INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (pack_id, pack_language, track_id),
			FOREIGN KEY (pack_id, pack_language) REFERENCES packs(id, language) ON DELETE CASCADE)`,
		`CREATE INDEX idx_pack_tracks_pack ON pack_tracks(pack_id, pack_language, position)`,
		`INSERT INTO migrations (name, scheme, applied_at) VALUES ('003_add_packs', 20260520, 1)`,
		`INSERT INTO packs (id, language, name, featured, sort_order) VALUES ('pack_AbCdEfGhIjKl', 'ru', 'Карма', 1, 10)`,
		`INSERT INTO pack_tracks (pack_id, pack_language, track_id, position) VALUES ('pack_AbCdEfGhIjKl', 'ru', 'track_1', 0)`,
		`INSERT INTO pack_tracks (pack_id, pack_language, track_id, position) VALUES ('pack_AbCdEfGhIjKl', 'ru', 'track_2', 1)`,
	}
	for _, s := range legacy {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("legacy setup %q: %v", s, err)
		}
	}

	if err := ensureCollectionTables(ctx, db); err != nil {
		t.Fatalf("ensureCollectionTables: %v", err)
	}

	if ok, _ := tableExists(ctx, db, "packs"); ok {
		t.Fatal("legacy packs table should have been renamed away")
	}
	if ok, _ := tableExists(ctx, db, "collections"); !ok {
		t.Fatal("collections table missing after migration")
	}

	var name string
	var featured, sortOrder int
	if err := db.QueryRow(
		`SELECT name, featured, sort_order FROM collections WHERE id='pack_AbCdEfGhIjKl' AND language='ru'`).
		Scan(&name, &featured, &sortOrder); err != nil {
		t.Fatalf("read collections: %v", err)
	}
	if name != "Карма" || featured != 1 || sortOrder != 10 {
		t.Fatalf("collection row not preserved: %q featured=%d sort=%d", name, featured, sortOrder)
	}

	rows, err := db.Query(
		`SELECT track_id FROM collection_tracks
		 WHERE collection_id='pack_AbCdEfGhIjKl' AND collection_language='ru' ORDER BY position`)
	if err != nil {
		t.Fatalf("read collection_tracks: %v", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) != 2 || ids[0] != "track_1" || ids[1] != "track_2" {
		t.Fatalf("membership not preserved after rename: %v", ids)
	}

	var scheme int
	if err := db.QueryRow(`SELECT scheme FROM migrations ORDER BY name DESC LIMIT 1`).Scan(&scheme); err != nil {
		t.Fatalf("read scheme: %v", err)
	}
	if scheme != 20260613 {
		t.Fatalf("scheme = %d, want 20260613", scheme)
	}

	// Idempotent: a second open is a clean no-op.
	if err := ensureCollectionTables(ctx, db); err != nil {
		t.Fatalf("second ensureCollectionTables: %v", err)
	}
}

func TestCollectionCRUDLifecycle(t *testing.T) {
	r, done := newCollectionTestRepo(t)
	defer done()
	ctx := context.Background()

	const collectionID = "pack_AbCdEfGhIjKl"

	// Create RU + EN locales for the same logical collection.
	if err := r.CreateCollectionLocale(ctx, collectionID, "ru", "Лекции о карме", true, 10); err != nil {
		t.Fatalf("create ru: %v", err)
	}
	if err := r.CreateCollectionLocale(ctx, collectionID, "en", "Lectures on karma", true, 10); err != nil {
		t.Fatalf("create en: %v", err)
	}

	// Get: should collapse both locales.
	collection, tracksByLang, ok, err := r.GetCollection(ctx, collectionID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !ok {
		t.Fatal("get: not found")
	}
	if collection.Names["ru"] != "Лекции о карме" || collection.Names["en"] != "Lectures on karma" {
		t.Errorf("names mismatch: %#v", collection.Names)
	}
	if !collection.Featured["ru"] || !collection.Featured["en"] {
		t.Errorf("featured mismatch: %#v", collection.Featured)
	}
	if len(tracksByLang["ru"]) != 0 || len(tracksByLang["en"]) != 0 {
		t.Errorf("expected empty track lists, got %#v", tracksByLang)
	}

	// Update one locale.
	newName := "Лекции о карме и судьбе"
	if err := r.UpdateCollectionLocale(ctx, collectionID, "ru", &newName, nil, nil); err != nil {
		t.Fatalf("update: %v", err)
	}
	collection, _, _, _ = r.GetCollection(ctx, collectionID)
	if collection.Names["ru"] != newName {
		t.Errorf("after update, ru name = %q want %q", collection.Names["ru"], newName)
	}

	// Seed three RU tracks + populate collection_tracks via SetCollectionTracks.
	for _, tid := range []string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"} {
		seedTrackVariant(t, r.db, tid, "ru")
	}
	if err := r.SetCollectionTracks(ctx, collectionID, "ru",
		[]string{"track_aaaaaaaaaaaa", "track_bbbbbbbbbbbb", "track_cccccccccccc"}); err != nil {
		t.Fatalf("set tracks: %v", err)
	}

	_, tracksByLang, _, _ = r.GetCollection(ctx, collectionID)
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
	if err := r.AddCollectionTrack(ctx, collectionID, "ru", "track_dddddddddddd", &pos); err != nil {
		t.Fatalf("add: %v", err)
	}
	_, tracksByLang, _, _ = r.GetCollection(ctx, collectionID)
	want = []string{"track_aaaaaaaaaaaa", "track_dddddddddddd", "track_bbbbbbbbbbbb", "track_cccccccccccc"}
	got = tracksByLang["ru"]
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("after add: position[%d] = %q want %q", i, got[i], want[i])
		}
	}

	// Idempotent re-add: count stays the same.
	if err := r.AddCollectionTrack(ctx, collectionID, "ru", "track_dddddddddddd", nil); err != nil {
		t.Fatalf("re-add: %v", err)
	}
	_, tracksByLang, _, _ = r.GetCollection(ctx, collectionID)
	if len(tracksByLang["ru"]) != 4 {
		t.Errorf("re-add changed length to %d (want 4)", len(tracksByLang["ru"]))
	}

	// Remove the middle track — sequence should compact (no gaps).
	if err := r.RemoveCollectionTrack(ctx, collectionID, "ru", "track_dddddddddddd"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	_, tracksByLang, _, _ = r.GetCollection(ctx, collectionID)
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
	collections, err := r.ListCollections(ctx, catalog.CollectionListOpts{Language: &ru, Featured: &featured})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(collections) != 1 || collections[0].Id != collectionID {
		t.Errorf("list: %#v", collections)
	}

	// Delete the EN locale only — RU + its tracks survive.
	if err := r.DeleteCollectionLocale(ctx, collectionID, "en"); err != nil {
		t.Fatalf("delete_locale: %v", err)
	}
	collection, _, _, _ = r.GetCollection(ctx, collectionID)
	if _, ok := collection.Names["en"]; ok {
		t.Errorf("en locale should be gone, got %#v", collection.Names)
	}
	if collection.Names["ru"] == "" {
		t.Errorf("ru locale should survive, got %#v", collection.Names)
	}

	// Full delete: cascades collection_tracks.
	if err := r.DeleteCollection(ctx, collectionID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	_, _, ok, err = r.GetCollection(ctx, collectionID)
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	if ok {
		t.Errorf("get should be not-found after delete")
	}
	var leftover int
	row := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM collection_tracks WHERE collection_id = ?`, collectionID)
	if err := row.Scan(&leftover); err != nil {
		t.Fatalf("count collection_tracks: %v", err)
	}
	if leftover != 0 {
		t.Errorf("FK cascade left %d collection_tracks rows", leftover)
	}
}

func TestEnsureCollectionTablesIsIdempotent(t *testing.T) {
	r, done := newCollectionTestRepo(t)
	defer done()
	// newCollectionTestRepo already invoked ensureCollectionTables once via setup;
	// a second call must remain a no-op.
	if err := ensureCollectionTables(context.Background(), r.db); err != nil {
		t.Fatalf("second call (idempotent): %v", err)
	}
}

func TestCollectionTrackLanguagesMismatch(t *testing.T) {
	r, done := newCollectionTestRepo(t)
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
