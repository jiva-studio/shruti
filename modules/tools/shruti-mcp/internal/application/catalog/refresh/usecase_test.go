package refresh_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/catalogdb"
	catalogrefresh "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/refresh"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
)

// fakeCDN serves one published catalog file per version.
type fakeCDN struct {
	manifest string
	files    map[string][]byte
}

func (c fakeCDN) GetJSON(_ context.Context, _ string, out any) error {
	return json.Unmarshal([]byte(c.manifest), out)
}

func (c fakeCDN) GetFile(_ context.Context, key string) (io.ReadCloser, error) {
	b, ok := c.files[key]
	if !ok {
		return nil, fmt.Errorf("%s: not found", key)
	}
	return io.NopCloser(bytes.NewReader(b)), nil
}

type fixedClock struct{}

func (fixedClock) Now() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) }

// publishedCatalog builds a catalog file holding one author named name.
func publishedCatalog(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "published.db")
	db, err := sql.Open("sqlite3", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if err := catalogdb.MigrateCatalog(t.Context(), db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO authors (id, language, full_name) VALUES ('author_a', 'en', ?)`, name); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newRefresh(t *testing.T, cdn fakeCDN) (catalogrefresh.UseCase, *sqlitecatalog.Store) {
	t.Helper()
	out := t.TempDir()
	store, err := sqlitecatalog.OpenStore(t.Context(), filepath.Join(out, "artifacts", "catalog", "current.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return catalogrefresh.UseCase{
		OutDir:          out,
		SupportedScheme: catalogdb.Scheme,
		CDN:             cdn,
		SchemeReader:    sqlitecatalog.NewSchemeReader(),
		Catalog:         store,
		Clock:           fixedClock{},
	}, store
}

func authorName(t *testing.T, store *sqlitecatalog.Store) string {
	t.Helper()
	e, ok, err := store.GetDict(t.Context(), catalog.KindAuthor, "author_a")
	if err != nil || !ok {
		t.Fatalf("read author: %v %v", ok, err)
	}
	return e.Names["en"]
}

func TestRefreshInstallsTheNewestCompatibleVersionUnderAnOpenStore(t *testing.T) {
	cdn := fakeCDN{
		manifest: fmt.Sprintf(`{"databases":[{"version":1,"scheme":%d},{"version":3,"scheme":1}]}`, catalogdb.Scheme),
		files:    map[string][]byte{"public/db/shruti.1.db": publishedCatalog(t, "First")},
	}
	uc, store := newRefresh(t, cdn)
	if _, err := store.Scheme(t.Context()); err == nil {
		t.Fatal("an empty store answered before any refresh")
	}
	res, err := uc.Run(t.Context(), false)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if res.Version != 1 || !res.Refreshed {
		t.Fatalf("result %+v: the incompatible version 3 must be skipped", res)
	}
	if got := authorName(t, store); got != "First" {
		t.Fatalf("store reads %q after install", got)
	}

	// A newer version replaces the file under the same, still-open store.
	cdn.manifest = fmt.Sprintf(`{"databases":[{"version":2,"scheme":%d}]}`, catalogdb.Scheme)
	cdn.files["public/db/shruti.2.db"] = publishedCatalog(t, "Second")
	uc.CDN = cdn
	if _, err := uc.Run(t.Context(), false); err != nil {
		t.Fatalf("second refresh: %v", err)
	}
	if got := authorName(t, store); got != "Second" {
		t.Fatalf("store reads %q after the swap", got)
	}
}

func TestRefreshKeepsUnpublishedChangesUnlessForced(t *testing.T) {
	cdn := fakeCDN{
		manifest: fmt.Sprintf(`{"databases":[{"version":1,"scheme":%d}]}`, catalogdb.Scheme),
		files:    map[string][]byte{"public/db/shruti.1.db": publishedCatalog(t, "First")},
	}
	uc, store := newRefresh(t, cdn)
	if _, err := uc.Run(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateDictLocale(t.Context(), catalog.KindAuthor, "author_a", "en", "Edited", ""); err != nil {
		t.Fatal(err)
	}

	cdn.manifest = fmt.Sprintf(`{"databases":[{"version":2,"scheme":%d}]}`, catalogdb.Scheme)
	cdn.files["public/db/shruti.2.db"] = publishedCatalog(t, "Second")
	uc.CDN = cdn
	if _, err := uc.Run(t.Context(), false); err == nil || !strings.Contains(err.Error(), "unsaved changes") {
		t.Fatalf("refresh over unpublished changes: %v", err)
	}
	if got := authorName(t, store); got != "Edited" {
		t.Fatalf("a refused refresh changed the catalog to %q", got)
	}

	res, err := uc.Run(t.Context(), true)
	if err != nil {
		t.Fatalf("forced refresh: %v", err)
	}
	if got := authorName(t, store); got != "Second" {
		t.Fatalf("forced refresh left %q", got)
	}
	if _, err := os.Stat(res.SnapshotPath + ".before-refresh"); err != nil {
		t.Fatalf("the replaced catalog was not kept: %v", err)
	}
}

func TestRefreshRefusesAnUnreadableMetaWithoutForce(t *testing.T) {
	cdn := fakeCDN{
		manifest: fmt.Sprintf(`{"databases":[{"version":1,"scheme":%d}]}`, catalogdb.Scheme),
		files:    map[string][]byte{"public/db/shruti.1.db": publishedCatalog(t, "First")},
	}
	uc, _ := newRefresh(t, cdn)
	if _, err := uc.Run(t.Context(), false); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(uc.OutDir, "artifacts", "catalog", "meta.json")
	if err := os.WriteFile(meta, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := uc.Run(t.Context(), false); err == nil || !strings.Contains(err.Error(), "meta.json") {
		t.Fatalf("refresh over an unreadable meta.json: %v", err)
	}
}
