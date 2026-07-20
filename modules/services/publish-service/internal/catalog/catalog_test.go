package catalog

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// bytesFetcher serves fixed bytes as the catalog.
type bytesFetcher struct{ b []byte }

func (f bytesFetcher) Fetch(context.Context) ([]byte, error) { return f.b, nil }

// PublishedTrackIDs reads the `tracks.id` column out of a current.db-shaped
// SQLite file.
func TestPublishedTrackIDs(t *testing.T) {
	// Build a minimal current.db.
	path := filepath.Join(t.TempDir(), "current.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	for _, id := range []string{"trk-a", "trk-b", "trk-c"} {
		if _, err := db.Exec(`INSERT INTO tracks (id, title) VALUES (?, ?)`, id, "x"); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	db.Close()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file: %v", err)
	}

	r := NewReader(bytesFetcher{b: blob})
	ids, err := r.PublishedTrackIDs(context.Background())
	if err != nil {
		t.Fatalf("PublishedTrackIDs: %v", err)
	}
	got := map[string]bool{}
	for _, id := range ids {
		got[id] = true
	}
	for _, want := range []string{"trk-a", "trk-b", "trk-c"} {
		if !got[want] {
			t.Errorf("missing track id %q (got %v)", want, ids)
		}
	}
	if len(ids) != 3 {
		t.Errorf("id count = %d, want 3", len(ids))
	}
}
