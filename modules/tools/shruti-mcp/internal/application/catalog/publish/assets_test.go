package publish

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// headUploader answers HEAD from a fixed set of held keys, so a test can
// describe exactly which advertised transcripts the target does not have.
type headUploader struct {
	held    map[string]bool
	headErr error
	probes  int
}

func (u *headUploader) Name() string   { return "fake" }
func (u *headUploader) Bucket() string { return "fake-bucket" }
func (u *headUploader) Put(context.Context, string, string, io.Reader, int64) error {
	return nil
}
func (u *headUploader) GetJSON(context.Context, string, any) (bool, error) { return false, nil }
func (u *headUploader) Get(context.Context, string) ([]byte, bool, error)  { return nil, false, nil }
func (u *headUploader) Head(_ context.Context, key string) (int64, string, bool, error) {
	u.probes++
	if u.headErr != nil {
		return 0, "", false, u.headErr
	}
	if u.held[key] {
		return 1, "", true, nil
	}
	return 0, "", false, nil
}

func transcriptPath(i int) string {
	return fmt.Sprintf("public/tracks/track_%03d/transcripts/ru.json", i)
}

// newCatalog writes a catalog DB advertising `paths` as transcripts.
func newCatalog(t *testing.T, paths []string) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "current.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE asset_hashes (
		path TEXT NOT NULL PRIMARY KEY, sha256 TEXT NOT NULL,
		track_id TEXT, language TEXT, kind TEXT)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	for _, p := range paths {
		if _, err := tx.Exec(
			`INSERT INTO asset_hashes (path, sha256, track_id, language, kind)
			 VALUES (?, 'sha', 't', 'ru', 'transcript')`, p); err != nil {
			t.Fatalf("seed %s: %v", p, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return dbPath
}

func heldAll(paths []string) map[string]bool {
	out := map[string]bool{}
	for _, p := range paths {
		out[p] = true
	}
	return out
}

func TestVerifyPassesWhenTargetHoldsEverything(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	db := newCatalog(t, paths)
	target := &headUploader{held: heldAll(paths)}

	check, missing, err := verifyTranscriptAssets(context.Background(), db, target, 4)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 0 || check.Pruned != 0 {
		t.Errorf("missing=%v pruned=%d, want none", missing, check.Pruned)
	}
	if check.Checked != 2 || target.probes != 2 {
		t.Errorf("checked=%d probes=%d, want 2/2", check.Checked, target.probes)
	}
}

// The reported case: a catalog advertising an `en.json` that was never
// uploaded. The row must not reach the published DB.
func TestVerifyReportsAndPrunesUnbackedTranscript(t *testing.T) {
	phantom := "public/tracks/track_DuNeWMKFeWts/transcripts/en.json"
	real := "public/tracks/track_DuNeWMKFeWts/transcripts/ru.json"
	db := newCatalog(t, []string{phantom, real})
	target := &headUploader{held: map[string]bool{real: true}}

	check, missing, err := verifyTranscriptAssets(context.Background(), db, target, 4)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 1 || missing[0] != phantom {
		t.Fatalf("missing=%v, want [%s]", missing, phantom)
	}
	if check.Pruned != 1 || len(check.PrunedSample) != 1 {
		t.Errorf("check=%+v, want 1 pruned", check)
	}

	pruned, err := writePrunedCopy(context.Background(), db, missing)
	if err != nil {
		t.Fatalf("writePrunedCopy: %v", err)
	}
	defer removeDBFiles(pruned)

	got, err := listTranscriptAssets(context.Background(), pruned)
	if err != nil {
		t.Fatalf("read pruned copy: %v", err)
	}
	if len(got) != 1 || got[0] != real {
		t.Errorf("pruned copy advertises %v, want [%s]", got, real)
	}
	// The local catalog keeps the row: the asset may still be uploaded,
	// and the next publish re-checks.
	still, err := listTranscriptAssets(context.Background(), db)
	if err != nil || len(still) != 2 {
		t.Errorf("current.db was mutated: %v (err=%v)", still, err)
	}
}

// A target answering "not found" wholesale is broken, not a source of
// stale rows — shipping a catalog stripped of the corpus would take chat
// search down.
func TestVerifyRefusesWhenTooMuchIsMissing(t *testing.T) {
	var paths []string
	for i := 0; i < 200; i++ {
		paths = append(paths, transcriptPath(i))
	}
	db := newCatalog(t, paths)
	target := &headUploader{held: map[string]bool{}}

	_, _, err := verifyTranscriptAssets(context.Background(), db, target, 8)
	if err == nil {
		t.Fatal("expected publish to refuse, got nil error")
	}
}

// An erroring probe is not evidence of absence.
func TestVerifyKeepsUnverifiablePaths(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	db := newCatalog(t, paths)
	target := &headUploader{headErr: fmt.Errorf("connection reset")}

	check, missing, err := verifyTranscriptAssets(context.Background(), db, target, 4)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 0 || check.Unverifiable != 2 {
		t.Errorf("missing=%v unverifiable=%d, want 0/2", missing, check.Unverifiable)
	}
}

// A catalog written before the asset_hashes schema advertises nothing.
func TestVerifyToleratesMissingTable(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE tracks (id TEXT)`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	db.Close()

	check, missing, err := verifyTranscriptAssets(context.Background(), dbPath, &headUploader{}, 2)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if check.Checked != 0 || len(missing) != 0 {
		t.Errorf("check=%+v missing=%v, want empty", check, missing)
	}
}
