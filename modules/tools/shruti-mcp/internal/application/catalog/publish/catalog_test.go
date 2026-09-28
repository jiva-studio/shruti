package publish

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
)

// splitTranscriptPath pulls (track_id, language) back out of
// public/tracks/<id>/transcripts/<lang>.json so a fixture path is enough to
// describe a whole variant.
func splitTranscriptPath(p string) (string, string) {
	parts := strings.Split(p, "/")
	lang := strings.TrimSuffix(parts[len(parts)-1], ".json")
	return parts[len(parts)-3], lang
}

// newOutDir lays out artifacts/catalog/ with a current.db advertising paths as
// transcripts in both places a catalog advertises them — asset_hashes, which
// the chat indexer lists, and track_variants.transcript_path, which clients
// read — and opens the store publish snapshots.
func newOutDir(t *testing.T, paths []string) (string, *sqlitecatalog.Store) {
	t.Helper()
	outDir := t.TempDir()
	catalogDir := filepath.Join(outDir, "artifacts", "catalog")
	if err := os.MkdirAll(catalogDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(catalogDir, "current.db")
	store, err := sqlitecatalog.OpenStore(t.Context(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "seed.db")
	seedCatalog(t, src, paths)
	if err := store.Install(t.Context(), src, ""); err != nil {
		t.Fatalf("install seed catalog: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	meta, err := json.Marshal(map[string]any{"modified": true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(catalogDir, "meta.json"), meta, 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}
	return outDir, store
}

func seedCatalog(t *testing.T, path string, paths []string) {
	t.Helper()
	r, err := sqlitecatalog.Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	// Closing the last connection folds the log into the file Install copies.
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	for _, p := range paths {
		trackID, lang := splitTranscriptPath(p)
		for _, q := range []string{
			`INSERT OR IGNORE INTO tracks (id) VALUES (?1)`,
			`INSERT INTO asset_hashes (path, sha256, track_id, language, kind) VALUES (?3, 'sha', ?1, ?2, 'transcript')`,
			`INSERT INTO track_variants (track_id, language, title, transcript_path, transcript_kind) VALUES (?1, ?2, 'title', ?3, 'original')`,
		} {
			if _, err := db.Exec(q, trackID, lang, p); err != nil {
				t.Fatalf("seed %s: %v", p, err)
			}
		}
	}
}

func openDB(t *testing.T, path, query string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+path+query)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func column(t *testing.T, path, query string) []string {
	t.Helper()
	rows, err := openDB(t, path, "?mode=ro").Query(query)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// listTranscriptAssets reads the indexer's advertisement.
func listTranscriptAssets(t *testing.T, path string) []string {
	t.Helper()
	return column(t, path, `SELECT path FROM asset_hashes WHERE kind = 'transcript' ORDER BY path`)
}

// variantTranscriptPaths reads the clients' advertisement.
func variantTranscriptPaths(t *testing.T, path string) []string {
	t.Helper()
	return column(t, path, `SELECT transcript_path FROM track_variants
		WHERE transcript_path IS NOT NULL AND transcript_path <> '' ORDER BY transcript_path`)
}
