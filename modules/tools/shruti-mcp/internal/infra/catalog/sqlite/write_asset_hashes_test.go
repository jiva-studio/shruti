package sqlitecatalog

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// setupAssetHashSchema extends the FTS fixture with the tables SaveTrack
// writes beyond search: authors (existence check), track_audio, the outline
// columns, and asset_hashes itself.
func setupAssetHashSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	setupFtsSchema(t, db)
	stmts := []string{
		`ALTER TABLE tracks ADD COLUMN contributor_user_id TEXT`,
		`ALTER TABLE track_variants ADD COLUMN outline TEXT`,
		`ALTER TABLE track_variants ADD COLUMN description TEXT`,
		`CREATE TABLE authors (
			id TEXT, language TEXT, full_name TEXT,
			PRIMARY KEY (id, language))`,
		`CREATE TABLE track_audio (
			track_id TEXT, language TEXT, kind TEXT, path TEXT,
			filesize INTEGER, duration INTEGER,
			PRIMARY KEY (track_id, language, kind))`,
		`INSERT INTO authors (id, language, full_name) VALUES ('author_x', 'en', 'X')`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("setup: %s: %v", s, err)
		}
	}
	if err := ensureAssetHashesTable(context.Background(), db); err != nil {
		t.Fatalf("ensureAssetHashesTable: %v", err)
	}
}

func newAssetHashRepo(t *testing.T) (*Repo, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	setupAssetHashSchema(t, db)
	return &Repo{db: db, path: ":memory:"}, db
}

func saveVariant(t *testing.T, r *Repo, lang, transcriptPath, sha string) {
	t.Helper()
	err := r.SaveTrackImpl(context.Background(),
		catalog.TrackRow{Id: "track_x", AuthorID: "author_x", Date: "1974-06-22"},
		catalog.VariantRow{
			TrackID:          "track_x",
			Language:         lang,
			Title:            "T",
			TranscriptPath:   transcriptPath,
			TranscriptKind:   "generated",
			TranscriptSHA256: sha,
		}, nil, nil)
	if err != nil {
		t.Fatalf("SaveTrackImpl(%s): %v", lang, err)
	}
}

func assetPaths(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT path FROM asset_hashes ORDER BY path`)
	if err != nil {
		t.Fatalf("read asset_hashes: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, p)
	}
	return out
}

// A variant that stops carrying a transcript must stop being advertised:
// the row is the chat indexer's only listing, and one left behind makes it
// re-fetch a 404 on every run.
func TestSaveTrackClearsAssetHashWhenTranscriptGone(t *testing.T) {
	r, db := newAssetHashRepo(t)

	saveVariant(t, r, "en", "public/tracks/track_x/transcripts/en.json", "deadbeef")
	if got := assetPaths(t, db); len(got) != 1 {
		t.Fatalf("after commit: got %v, want 1 row", got)
	}

	saveVariant(t, r, "en", "", "")
	if got := assetPaths(t, db); len(got) != 0 {
		t.Errorf("after transcript-less save: got %v, want none", got)
	}
}

func TestDeleteTrackVariantDropsAssetHash(t *testing.T) {
	r, db := newAssetHashRepo(t)

	saveVariant(t, r, "ru", "public/tracks/track_x/transcripts/ru.json", "aaa")
	saveVariant(t, r, "en", "public/tracks/track_x/transcripts/en.json", "bbb")
	if got := assetPaths(t, db); len(got) != 2 {
		t.Fatalf("setup: got %v, want 2 rows", got)
	}

	if err := r.DeleteTrackVariantImpl(context.Background(), "track_x", "en"); err != nil {
		t.Fatalf("DeleteTrackVariantImpl: %v", err)
	}

	got := assetPaths(t, db)
	want := []string{"public/tracks/track_x/transcripts/ru.json"}
	if len(got) != 1 || got[0] != want[0] {
		t.Errorf("after delete: got %v, want %v", got, want)
	}
}
