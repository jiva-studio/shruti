package publish

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

// recordingUploader keeps every uploaded body so a test can inspect the
// bytes that actually left for the bucket — the only place the "did the
// pruned copy ship?" question can be answered.
type recordingUploader struct {
	headUploader

	putMu sync.Mutex
	puts  map[string][]byte
}

func newRecordingUploader(held map[string]bool) *recordingUploader {
	return &recordingUploader{
		headUploader: headUploader{held: held},
		puts:         map[string][]byte{},
	}
}

func (u *recordingUploader) Put(_ context.Context, key, _ string, body io.Reader, _ int64) error {
	b, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	u.putMu.Lock()
	defer u.putMu.Unlock()
	u.puts[key] = b
	return nil
}

// uploadedDB writes the shipped .db bytes back out so they can be opened.
func (u *recordingUploader) uploadedDB(t *testing.T) string {
	t.Helper()
	u.putMu.Lock()
	defer u.putMu.Unlock()
	for key, body := range u.puts {
		if !strings.HasPrefix(key, "public/db/") {
			continue
		}
		path := filepath.Join(t.TempDir(), "uploaded.db")
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatalf("write uploaded db: %v", err)
		}
		return path
	}
	t.Fatalf("no catalog DB was uploaded (keys: %v)", u.puts)
	return ""
}

// newOutDir lays out the artifacts/catalog/ tree publish expects and seeds
// current.db with the given advertised transcripts.
func newOutDir(t *testing.T, paths []string) string {
	t.Helper()
	outDir := t.TempDir()
	catalogDir := filepath.Join(outDir, "artifacts", "catalog")
	if err := os.MkdirAll(catalogDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	newCatalogAt(t, filepath.Join(catalogDir, "current.db"), paths)
	meta, _ := json.Marshal(map[string]any{"modified": true})
	if err := os.WriteFile(filepath.Join(catalogDir, "meta.json"), meta, 0o644); err != nil {
		t.Fatalf("write meta: %v", err)
	}
	return outDir
}

// The central claim of this change, asserted end to end on Run: the bytes
// that reach the bucket are the PRUNED copy. Verifying the prune helpers in
// isolation cannot catch a Run that computes the pruned copy and then
// uploads current.db anyway.
func TestRunUploadsThePrunedCatalog(t *testing.T) {
	phantom := "public/tracks/track_DuNeWMKFeWts/transcripts/en.json"
	real := "public/tracks/track_DuNeWMKFeWts/transcripts/ru.json"
	outDir := newOutDir(t, []string{phantom, real})
	target := newRecordingUploader(map[string]bool{real: true})

	uc := UseCase{OutDir: outDir, SupportedScheme: 1, Targets: []s3port.Uploader{target}}
	res, err := uc.Run(context.Background(), Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Assets == nil || res.Assets.Pruned != 1 {
		t.Fatalf("assets=%+v, want 1 pruned", res.Assets)
	}

	shipped := target.uploadedDB(t)
	got, err := listTranscriptAssets(context.Background(), shipped)
	if err != nil {
		t.Fatalf("read shipped db: %v", err)
	}
	if len(got) != 1 || got[0] != real {
		t.Errorf("published catalog advertises %v to the indexer, want [%s]", got, real)
	}
	if vars := variantTranscriptPaths(t, shipped); len(vars) != 1 || vars[0] != real {
		t.Errorf("published catalog points clients at %v, want [%s]", vars, real)
	}

	// current.db is the local record and must survive the publish whole.
	local := filepath.Join(outDir, "artifacts", "catalog", "current.db")
	still, err := listTranscriptAssets(context.Background(), local)
	if err != nil || len(still) != 2 {
		t.Errorf("current.db was mutated: %v (err=%v)", still, err)
	}
}

// Nothing missing → the untouched current.db ships, and no stray pruned
// copy is left behind in artifacts/catalog/.
func TestRunShipsCurrentDBWhenNothingIsMissing(t *testing.T) {
	paths := []string{transcriptPath(1), transcriptPath(2)}
	outDir := newOutDir(t, paths)
	target := newRecordingUploader(heldAll(paths))

	uc := UseCase{OutDir: outDir, SupportedScheme: 1, Targets: []s3port.Uploader{target}}
	res, err := uc.Run(context.Background(), Options{})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Assets == nil || res.Assets.Pruned != 0 || res.Assets.Checked != 2 {
		t.Fatalf("assets=%+v, want 2 checked / 0 pruned", res.Assets)
	}
	if got, err := listTranscriptAssets(context.Background(), target.uploadedDB(t)); err != nil || len(got) != 2 {
		t.Errorf("published catalog advertises %v (err=%v), want both", got, err)
	}

	entries, err := os.ReadDir(filepath.Join(outDir, "artifacts", "catalog"))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".publish-") {
			t.Errorf("temp copy %s left behind", e.Name())
		}
	}
}

// skip_asset_check ships whatever the catalog says, phantoms and all — the
// documented cost of the escape hatch.
func TestRunSkipAssetCheckShipsEverything(t *testing.T) {
	phantom := "public/tracks/track_DuNeWMKFeWts/transcripts/en.json"
	real := "public/tracks/track_DuNeWMKFeWts/transcripts/ru.json"
	outDir := newOutDir(t, []string{phantom, real})
	target := newRecordingUploader(map[string]bool{real: true})

	uc := UseCase{OutDir: outDir, SupportedScheme: 1, Targets: []s3port.Uploader{target}}
	res, err := uc.Run(context.Background(), Options{SkipAssetCheck: true})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Assets != nil {
		t.Errorf("assets=%+v, want no check reported", res.Assets)
	}
	if target.probeCount() != 0 {
		t.Errorf("probed %d times, want 0", target.probeCount())
	}
	if got, _ := listTranscriptAssets(context.Background(), target.uploadedDB(t)); len(got) != 2 {
		t.Errorf("published catalog advertises %v, want both (unpruned)", got)
	}
}
