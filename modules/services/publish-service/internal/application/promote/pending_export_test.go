package promote_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/jiva-studio/shruti/publish/internal/pending"
)

// Export returns a pending.db holding only the unpublished tracks and leaves
// nothing behind in the temporary directory.
func TestExportHoldsTheUnpublishedTracksAndLeavesNoFiles(t *testing.T) {
	pool := testPool(t)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `
		INSERT INTO publish.tracks (track_id, owner_id, metadata, lang, published) VALUES
			('t1', 'o1', '{"title_raw":"One"}', 'en', false),
			('t2', 'o2', '{}', NULL, false),
			('t3', 'o3', '{}', 'ru', true)`); err != nil {
		t.Fatal(err)
	}
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	db, tracks, err := pending.NewExporter(pool).Export(ctx)
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if tracks != 2 {
		t.Errorf("tracks = %d, want 2", tracks)
	}
	if left, _ := os.ReadDir(tmp); len(left) != 0 {
		t.Errorf("temporary files left behind: %v", left)
	}

	path := filepath.Join(t.TempDir(), "pending.db")
	if err := os.WriteFile(path, db, 0o600); err != nil {
		t.Fatal(err)
	}
	sqlite, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer sqlite.Close()
	rows, err := sqlite.QueryContext(ctx, `SELECT track_id, owner_id, lang FROM pending ORDER BY track_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var id, owner, lang string
		if err := rows.Scan(&id, &owner, &lang); err != nil {
			t.Fatal(err)
		}
		got = append(got, id+"/"+owner+"/"+lang)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"t1/o1/en", "t2/o2/ru"}; len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("pending rows = %v, want %v", got, want)
	}
}
