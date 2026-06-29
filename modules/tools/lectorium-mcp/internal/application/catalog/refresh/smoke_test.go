//go:build smoke

package refresh_test

import (
	"context"
	"os"
	"sync"
	"testing"

	catalogrefresh "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/refresh"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	sqlitecatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite"
	httpcdn "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/cdn/http"
)

// TestRefreshFromCDN actually hits production CDN. Run with:
//   go test -tags=smoke ./internal/application/catalog/refresh/...
func TestRefreshFromCDN(t *testing.T) {
	dir := t.TempDir()
	uc := catalogrefresh.UseCase{
		OutDir:          dir,
		SupportedScheme: catalog.SupportedDBScheme,
		CDN:             httpcdn.New("https://akds-lectorium.s3.us-east-1.amazonaws.com"),
		OpMutex:         &sync.Mutex{},
	}
	ctx := context.Background()
	res, err := uc.Run(ctx, false)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if res.Version == 0 || res.Scheme == 0 {
		t.Fatalf("empty result: %+v", res)
	}
	if _, err := os.Stat(res.SnapshotPath); err != nil {
		t.Fatalf("snapshot missing: %v", err)
	}
	if _, err := os.Stat(res.CurrentPath); err != nil {
		t.Fatalf("current missing: %v", err)
	}

	// Open and probe — make sure schema matches what we said and dictionaries are populated.
	repo, err := sqlitecatalog.Open(ctx, res.CurrentPath)
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer repo.Close()

	scheme, err := repo.Scheme(ctx)
	if err != nil {
		t.Fatalf("scheme: %v", err)
	}
	if scheme != catalog.SupportedDBScheme {
		t.Fatalf("scheme mismatch: got %d want %d", scheme, catalog.SupportedDBScheme)
	}

	authors, err := repo.ListDict(ctx, catalog.KindAuthor, catalog.ListOpts{Limit: 100})
	if err != nil {
		t.Fatalf("list authors: %v", err)
	}
	if len(authors) == 0 {
		t.Fatal("expected at least one author")
	}
	t.Logf("✓ refreshed v%d scheme=%d authors=%d", res.Version, res.Scheme, len(authors))

	// Second call with no force — must be no-op (current.db == snapshot, no edits).
	res2, err := uc.Run(ctx, false)
	if err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	if res2.Refreshed {
		t.Errorf("second refresh should not have re-downloaded")
	}
}
