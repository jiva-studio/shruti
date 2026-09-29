package sqlitecatalog

import (
	"database/sql"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

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

func TestCollectionCRUDLifecycle(t *testing.T) {
	r, done := newTestRepo(t)
	defer done()
	ctx := t.Context()

	const collectionID = "pack_AbCdEfGhIjKl"

	// Create RU + EN locales for the same logical collection.
	if err := r.CreateCollectionLocale(ctx, collectionID, "ru", "Лекции о карме", "public/collections/x/cover.jpg", "Про карму", "", 10); err != nil {
		t.Fatalf("create ru: %v", err)
	}
	if err := r.CreateCollectionLocale(ctx, collectionID, "en", "Lectures on karma", "", "", "", 10); err != nil {
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
	if collection.Covers["ru"] != "public/collections/x/cover.jpg" || collection.Descriptions["ru"] != "Про карму" {
		t.Errorf("cover/description mismatch: %#v / %#v", collection.Covers, collection.Descriptions)
	}
	if len(tracksByLang["ru"]) != 0 || len(tracksByLang["en"]) != 0 {
		t.Errorf("expected empty track lists, got %#v", tracksByLang)
	}

	// Featured is modelled as a tag — add tag_featured to both locales.
	if err := r.AddCollectionTag(ctx, collectionID, "ru", "tag_featured"); err != nil {
		t.Fatalf("add tag ru: %v", err)
	}
	if err := r.AddCollectionTag(ctx, collectionID, "en", "tag_featured"); err != nil {
		t.Fatalf("add tag en: %v", err)
	}
	// Idempotent re-add.
	if err := r.AddCollectionTag(ctx, collectionID, "ru", "tag_featured"); err != nil {
		t.Fatalf("re-add tag ru: %v", err)
	}
	collection, _, _, _ = r.GetCollection(ctx, collectionID)
	if len(collection.TagIDs["ru"]) != 1 || collection.TagIDs["ru"][0] != "tag_featured" {
		t.Errorf("ru tags mismatch: %#v", collection.TagIDs)
	}

	// Update one locale.
	newName := "Лекции о карме и судьбе"
	if err := r.UpdateCollectionLocale(ctx, collectionID, "ru", &newName, nil, nil, nil, nil); err != nil {
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

	// List filtered by the featured tag.
	ru := "ru"
	featuredTag := "tag_featured"
	collections, err := r.ListCollections(ctx, catalog.CollectionListOpts{Language: &ru, Tag: &featuredTag})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(collections) != 1 || collections[0].ID != collectionID {
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

func TestCollectionTrackLanguagesMismatch(t *testing.T) {
	r, done := newTestRepo(t)
	defer done()
	ctx := t.Context()

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
