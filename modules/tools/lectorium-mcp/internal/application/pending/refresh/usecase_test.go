package refresh

import (
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	sqlitepending "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/pending/sqlite"
)

// fakeCDN serves a fixed byte payload for any key, or an error.
type fakeCDN struct {
	payload []byte
	err     error
}

func (f fakeCDN) GetJSON(_ context.Context, _ string, _ any) error { return f.err }
func (f fakeCDN) GetFile(_ context.Context, _ string) (io.ReadCloser, error) {
	if f.err != nil {
		return nil, f.err
	}
	return io.NopCloser(bytes.NewReader(f.payload)), nil
}

// validPendingBytes builds a real, well-formed pending.db and returns its bytes.
func validPendingBytes(t *testing.T) []byte {
	t.Helper()
	p := filepath.Join(t.TempDir(), "seed.db")
	r, err := sqlitepending.Open(t.Context(), p)
	if err != nil {
		t.Fatalf("seed open: %v", err)
	}
	r.Close()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}
	return b
}

func TestRefreshDownloadsVerifiesAndSwaps(t *testing.T) {
	ctx := t.Context()
	out := t.TempDir()
	uc := UseCase{
		OutDir:   out,
		CDN:      fakeCDN{payload: validPendingBytes(t)},
		Verifier: sqlitepending.NewVerifier(),
	}
	res, err := uc.Run(ctx)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if res.Path != uc.Path() {
		t.Errorf("path = %q, want %q", res.Path, uc.Path())
	}
	if res.SizeBytes == 0 || res.SHA256 == "" {
		t.Errorf("empty result: %+v", res)
	}
	if _, err := os.Stat(uc.Path()); err != nil {
		t.Fatalf("live pending.db missing after swap: %v", err)
	}
	// The swapped file must be openable + readable as a pending queue.
	r, err := sqlitepending.Open(ctx, uc.Path())
	if err != nil {
		t.Fatalf("open swapped: %v", err)
	}
	r.Close()
}

func TestRefreshRejectsCorruptDownloadAndKeepsLiveFile(t *testing.T) {
	ctx := t.Context()
	out := t.TempDir()
	uc := UseCase{OutDir: out, Verifier: sqlitepending.NewVerifier()}

	// Seed a good live file first.
	uc.CDN = fakeCDN{payload: validPendingBytes(t)}
	if _, err := uc.Run(ctx); err != nil {
		t.Fatalf("initial refresh: %v", err)
	}
	goodInfo, err := os.Stat(uc.Path())
	if err != nil {
		t.Fatalf("stat good: %v", err)
	}

	// Now a corrupt payload must be rejected and leave the good file untouched.
	uc.CDN = fakeCDN{payload: []byte("<html>403 Forbidden</html>")}
	if _, err := uc.Run(ctx); err == nil {
		t.Fatal("expected verify failure on corrupt payload")
	}
	after, err := os.Stat(uc.Path())
	if err != nil {
		t.Fatalf("live file gone after failed refresh: %v", err)
	}
	if after.Size() != goodInfo.Size() {
		t.Errorf("live file changed after failed refresh: %d -> %d", goodInfo.Size(), after.Size())
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(filepath.Dir(uc.Path()))
	for _, e := range entries {
		if e.Name() != "pending.db" {
			t.Errorf("leftover file in artifact dir: %s", e.Name())
		}
	}
}
