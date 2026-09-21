package publish

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// headUploader answers HEAD from a fixed set of held keys, so a test can
// describe exactly which advertised transcripts the target does not have.
type headUploader struct {
	held    map[string]bool
	headErr error

	mu     sync.Mutex
	probes int
	// onProbe, if set, runs after each probe is counted — a hook for
	// cancelling the run mid-sweep.
	onProbe func(n int)
}

func (u *headUploader) Name() string   { return "fake" }
func (u *headUploader) Bucket() string { return "fake-bucket" }
func (u *headUploader) Put(context.Context, string, string, io.Reader, int64) error {
	return nil
}
func (u *headUploader) GetJSON(context.Context, string, any) (bool, error) { return false, nil }
func (u *headUploader) Get(context.Context, string) ([]byte, bool, error)  { return nil, false, nil }
func (u *headUploader) Head(_ context.Context, key string) (int64, string, bool, error) {
	u.mu.Lock()
	u.probes++
	n := u.probes
	hook := u.onProbe
	u.mu.Unlock()
	if hook != nil {
		hook(n)
	}
	if u.headErr != nil {
		return 0, "", false, u.headErr
	}
	if u.held[key] {
		return 1, "", true, nil
	}
	return 0, "", false, nil
}

func (u *headUploader) probeCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.probes
}

func transcriptPath(i int) string {
	return fmt.Sprintf("public/tracks/track_%03d/transcripts/ru.json", i)
}

// splitTranscriptPath pulls (track_id, language) back out of
// public/tracks/<id>/transcripts/<lang>.json so a fixture path is enough to
// describe a whole variant.
func splitTranscriptPath(p string) (string, string) {
	parts := strings.Split(p, "/")
	lang := strings.TrimSuffix(parts[len(parts)-1], ".json")
	return parts[len(parts)-3], lang
}

// newCatalog writes a catalog DB advertising `paths` as transcripts — in
// BOTH places the catalog advertises them: the `asset_hashes` row the chat
// indexer lists, and the `track_variants.transcript_path` the clients read.
func newCatalog(t *testing.T, paths []string) string {
	t.Helper()
	return newCatalogAt(t, filepath.Join(t.TempDir(), "current.db"), paths)
}

func newCatalogAt(t *testing.T, dbPath string, paths []string) string {
	t.Helper()
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
	if _, err := db.Exec(`CREATE TABLE track_variants (
		track_id TEXT NOT NULL, language TEXT NOT NULL, title TEXT,
		transcript_path TEXT, transcript_kind TEXT,
		PRIMARY KEY (track_id, language))`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	for _, p := range paths {
		trackID, lang := splitTranscriptPath(p)
		if _, err := tx.Exec(
			`INSERT INTO asset_hashes (path, sha256, track_id, language, kind)
			 VALUES (?, 'sha', ?, ?, 'transcript')`, p, trackID, lang); err != nil {
			t.Fatalf("seed %s: %v", p, err)
		}
		if _, err := tx.Exec(
			`INSERT INTO track_variants (track_id, language, title, transcript_path, transcript_kind)
			 VALUES (?, ?, 'title', ?, 'original')`, trackID, lang, p); err != nil {
			t.Fatalf("seed variant %s: %v", p, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return dbPath
}

// variantTranscriptPaths reads the OTHER advertisement — what a client
// resolves when it asks the catalog for a track's transcript.
func variantTranscriptPaths(t *testing.T, dbPath string) []string {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?mode=ro")
	if err != nil {
		t.Fatalf("open %s: %v", dbPath, err)
	}
	defer db.Close()
	rows, err := db.Query(
		`SELECT transcript_path FROM track_variants
		 WHERE transcript_path IS NOT NULL AND transcript_path <> ''
		 ORDER BY transcript_path`)
	if err != nil {
		t.Fatalf("read track_variants: %v", err)
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
	if err := rows.Err(); err != nil {
		t.Fatalf("read track_variants: %v", err)
	}
	return out
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

	check, missing, err := verifyTranscriptAssets(t.Context(), db, target, assetCheckOpts{Concurrency: 4})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 0 || check.Pruned != 0 {
		t.Errorf("missing=%v pruned=%d, want none", missing, check.Pruned)
	}
	if check.Checked != 2 || target.probeCount() != 2 {
		t.Errorf("checked=%d probes=%d, want 2/2", check.Checked, target.probeCount())
	}
}

// The reported case: a catalog advertising an `en.json` that was never
// uploaded. The row must not reach the published DB.
func TestVerifyReportsAndPrunesUnbackedTranscript(t *testing.T) {
	phantom := "public/tracks/track_DuNeWMKFeWts/transcripts/en.json"
	backed := "public/tracks/track_DuNeWMKFeWts/transcripts/ru.json"
	db := newCatalog(t, []string{phantom, backed})
	target := &headUploader{held: map[string]bool{backed: true}}

	check, missing, err := verifyTranscriptAssets(t.Context(), db, target, assetCheckOpts{Concurrency: 4})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(missing) != 1 || missing[0] != phantom {
		t.Fatalf("missing=%v, want [%s]", missing, phantom)
	}
	if check.Pruned != 1 || len(check.PrunedSample) != 1 {
		t.Errorf("check=%+v, want 1 pruned", check)
	}

	pruned, err := writePrunedCopy(t.Context(), db, missing)
	if err != nil {
		t.Fatalf("writePrunedCopy: %v", err)
	}
	defer removeDBFiles(pruned)

	got, err := listTranscriptAssets(t.Context(), pruned)
	if err != nil {
		t.Fatalf("read pruned copy: %v", err)
	}
	if len(got) != 1 || got[0] != backed {
		t.Errorf("pruned copy advertises %v, want [%s]", got, backed)
	}
	// asset_hashes is only the indexer's listing. Mobile and chat resolve
	// track_variants.transcript_path, so a copy that dropped the hash row
	// and kept the pointer still hands every reader the 404.
	if vars := variantTranscriptPaths(t, pruned); len(vars) != 1 || vars[0] != backed {
		t.Errorf("pruned copy still points clients at %v, want [%s]", vars, backed)
	}
	// The local catalog keeps both: the asset may still be uploaded, and
	// the next publish re-checks.
	still, err := listTranscriptAssets(t.Context(), db)
	if err != nil || len(still) != 2 {
		t.Errorf("current.db was mutated: %v (err=%v)", still, err)
	}
	if vars := variantTranscriptPaths(t, db); len(vars) != 2 {
		t.Errorf("current.db track_variants was mutated: %v", vars)
	}
}

// force_prune is the narrow escape from the budget: over-budget phantoms
// are dropped from the published copy instead of the publish being refused,
// which is what skip_asset_check would otherwise force (shipping all of
// them). The refusal still stands without it.
func TestForcePruneWaivesTheBudget(t *testing.T) {
	var paths []string
	for i := 0; i < 200; i++ {
		paths = append(paths, transcriptPath(i))
	}
	held := heldAll(paths)
	var phantoms []string
	for i := 0; i < 60; i++ { // over max(50, 5% of 200)
		delete(held, paths[i])
		phantoms = append(phantoms, paths[i])
	}
	db := newCatalog(t, paths)

	if _, _, err := verifyTranscriptAssets(t.Context(), db,
		&headUploader{held: held}, assetCheckOpts{Concurrency: 8}); err == nil {
		t.Fatal("60 phantoms over budget: expected a refusal without force")
	}

	check, missing, err := verifyTranscriptAssets(t.Context(), db,
		&headUploader{held: held}, assetCheckOpts{Concurrency: 8, Force: true})
	if err != nil {
		t.Fatalf("force verify: %v", err)
	}
	if len(missing) != len(phantoms) || check.Pruned != len(phantoms) || !check.Forced {
		t.Errorf("check=%+v missing=%d, want %d pruned and forced", check, len(missing), len(phantoms))
	}
}

// A cancelled sweep probed a prefix of the corpus at most, so it is a
// verdict on nothing — reporting the unprobed remainder as present would
// let a half-checked catalog ship.
func TestVerifyRejectsACancelledSweep(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	db := newCatalog(t, paths)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if _, _, err := verifyTranscriptAssets(ctx, db, &headUploader{}, assetCheckOpts{Concurrency: 2}); err == nil {
		t.Fatal("expected a cancelled asset check to report an error")
	}
}

// The workers leave the moment ctx is done, so the producer's send has to
// watch ctx too — otherwise it blocks on a channel nobody reads again,
// forever, while publish is holding OpMutex. That hang wedges the whole
// tool, so it is asserted with a hard deadline rather than left to the
// package timeout.
func TestMissingAssetsReturnsWhenContextIsCancelled(t *testing.T) {
	var paths []string
	for i := 0; i < 500; i++ {
		paths = append(paths, transcriptPath(i))
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	target := &headUploader{
		held:    heldAll(paths),
		onProbe: func(int) { cancel() },
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		missingAssets(ctx, target, paths, 2)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("missingAssets never returned after the context was cancelled — " +
			"the producer is blocked sending to workers that already left")
	}
	if n := target.probeCount(); n >= len(paths) {
		t.Errorf("probed %d of %d paths — the sweep did not stop on cancel", n, len(paths))
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

	_, _, err := verifyTranscriptAssets(t.Context(), db, target, assetCheckOpts{Concurrency: 8})
	if err == nil {
		t.Fatal("expected publish to refuse, got nil error")
	}
}

// An erroring probe is not evidence of absence.
func TestVerifyKeepsUnverifiablePaths(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	db := newCatalog(t, paths)
	target := &headUploader{headErr: fmt.Errorf("connection reset")}

	check, missing, err := verifyTranscriptAssets(t.Context(), db, target, assetCheckOpts{Concurrency: 4})
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

	check, missing, err := verifyTranscriptAssets(t.Context(), dbPath, &headUploader{}, assetCheckOpts{Concurrency: 2})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if check.Checked != 0 || len(missing) != 0 {
		t.Errorf("check=%+v missing=%v, want empty", check, missing)
	}
}
