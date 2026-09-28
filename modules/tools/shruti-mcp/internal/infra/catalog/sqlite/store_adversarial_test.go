package sqlitecatalog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// writeCatalogFile builds a migrated catalog at path holding one author.
func writeCatalogFile(t *testing.T, path, authorID string) {
	t.Helper()
	r, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.CreateDict(t.Context(), catalog.KindAuthor, catalog.DictEntry{
		ID: authorID, Names: map[string]string{"en": authorID},
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
}

// Calls running while snapshots are installed must wait for the swap, never
// reach a closed database or a half-copied file.
func TestCallsDuringRepeatedInstallsNeverSeeAClosedDatabase(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	dir := t.TempDir()
	const installs = 8
	srcs := make([]string, installs)
	for i := range srcs {
		srcs[i] = filepath.Join(dir, fmt.Sprintf("snap%d.db", i))
		writeCatalogFile(t, srcs[i], fmt.Sprintf("author_%d", i))
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := s.ListDict(ctx, catalog.KindAuthor, catalog.ListOpts{}); err != nil {
					errs <- err
					return
				}
				if err := s.SetSetting(ctx, "k", "v"); err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	for _, src := range srcs {
		if err := s.Install(ctx, src, ""); err != nil {
			close(stop)
			wg.Wait()
			t.Fatalf("install %s: %v", src, err)
		}
	}
	close(stop)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("call during install: %v", err)
	}
	last := fmt.Sprintf("author_%d", installs-1)
	if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, last); err != nil || !ok {
		t.Fatalf("last installed catalog not served: %v %v", ok, err)
	}
}

// A snapshot that cannot be read leaves the store serving the old catalog
// when no backup is asked for, and leaves no temporary file behind.
func TestInstallOfAnUnreadableSourceKeepsTheOldCatalog(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	if _, err := s.CreateDict(ctx, catalog.KindAuthor, catalog.DictEntry{
		ID: "author_keep", Names: map[string]string{"en": "Keep"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Install(ctx, filepath.Join(t.TempDir(), "missing.db"), ""); err == nil {
		t.Fatal("install of a missing source succeeded")
	}
	if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, "author_keep"); err != nil || !ok {
		t.Fatalf("old catalog lost after a failed install: %v %v", ok, err)
	}
	entries, err := os.ReadDir(filepath.Dir(s.Path()))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("temporary file left behind: %s", e.Name())
		}
	}
}

// A forced refresh (backup set) whose copy fails, or whose source is not a
// database, keeps serving the working catalog and writes no backup.
func TestForcedInstallThatFailsKeepsServingTheCatalog(t *testing.T) {
	cases := map[string]func(t *testing.T) string{
		"missing source": func(t *testing.T) string {
			return filepath.Join(t.TempDir(), "missing.db")
		},
		"source is not a database": func(t *testing.T) string {
			p := filepath.Join(t.TempDir(), "garbage.db")
			if err := os.WriteFile(p, []byte(strings.Repeat("not sqlite ", 512)), 0o600); err != nil {
				t.Fatal(err)
			}
			return p
		},
	}
	for name, src := range cases {
		t.Run(name, func(t *testing.T) {
			s := openTestStore(t)
			ctx := t.Context()
			if _, err := s.CreateDict(ctx, catalog.KindAuthor, catalog.DictEntry{
				ID: "author_keep", Names: map[string]string{"en": "Keep"},
			}); err != nil {
				t.Fatal(err)
			}
			backup := filepath.Join(t.TempDir(), "backup.db")
			if err := s.Install(ctx, src(t), backup); err == nil {
				t.Fatal("install of a bad source succeeded")
			}
			if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, "author_keep"); err != nil || !ok {
				t.Fatalf("catalog lost after a failed forced install: %v %v", ok, err)
			}
			if _, err := os.Stat(backup); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("backup written although nothing was replaced: %v", err)
			}
			leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(s.Path()), ".*.tmp-*"))
			if err != nil || len(leftovers) != 0 {
				t.Fatalf("staged copy left behind: %v %v", leftovers, err)
			}
		})
	}
}

// A forced install that succeeds keeps the replaced file as the backup.
func TestForcedInstallKeepsTheReplacedFileAsBackup(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	if _, err := s.CreateDict(ctx, catalog.KindAuthor, catalog.DictEntry{
		ID: "author_old", Names: map[string]string{"en": "Old"},
	}); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "snap.db")
	writeCatalogFile(t, src, "author_new")
	backup := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Install(ctx, src, backup); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, "author_new"); err != nil || !ok {
		t.Fatalf("new catalog not served: %v %v", ok, err)
	}
	old, err := Open(ctx, backup)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	if _, ok, err := old.GetDict(ctx, catalog.KindAuthor, "author_old"); err != nil || !ok {
		t.Fatalf("backup does not hold the replaced catalog: %v %v", ok, err)
	}
}

// Snapshot after Close reports the store as empty rather than using a closed
// handle.
func TestSnapshotAfterCloseIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "current.db")
	writeCatalogFile(t, path, "author_x")
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Snapshot(t.Context()); !errors.Is(err, ErrNotRefreshed) {
		t.Fatalf("snapshot after close: %v", err)
	}
}
