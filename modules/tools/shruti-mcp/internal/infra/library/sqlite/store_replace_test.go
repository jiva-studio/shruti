package sqlitelibrary

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// writeLibraryFile builds a library at path holding one attribution and
// closes it, the way an import leaves a finished file.
func writeLibraryFile(t *testing.T, path, attributionID string) {
	t.Helper()
	r, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.AttributionCreate(t.Context(), attributionID, library.AttrPinned, "en", attributionID); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
}

func openLibraryStore(t *testing.T, path string) *Store {
	t.Helper()
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

// An import renames a new library.db over the one the store holds open; the
// next call reads the new file, not the unlinked one.
func TestStoreReadsALibraryReplacedOnDisk(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "library.db")
	s := openLibraryStore(t, path)
	if err := s.AttributionCreate(ctx, "canonical_old", library.AttrPinned, "en", "old"); err != nil {
		t.Fatal(err)
	}

	next := filepath.Join(t.TempDir(), "library.db")
	writeLibraryFile(t, next, "canonical_new")
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := s.AttributionGet(ctx, "canonical_new"); err != nil || !ok {
		t.Fatalf("replaced library not read: %v %v", ok, err)
	}
	if _, ok, err := s.AttributionGet(ctx, "canonical_old"); err != nil || ok {
		t.Fatalf("store still reads the replaced file: %v %v", ok, err)
	}
	if err := s.AttributionCreate(ctx, "canonical_after", library.AttrPinned, "en", "after"); err != nil {
		t.Fatal(err)
	}
	snap, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	check := filepath.Join(t.TempDir(), "check.db")
	if err := os.WriteFile(check, snap, 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := Open(ctx, check)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	for _, id := range []string{"canonical_new", "canonical_after"} {
		if _, ok, err := r.AttributionGet(ctx, id); err != nil || !ok {
			t.Fatalf("snapshot of the replaced library misses %s: %v %v", id, ok, err)
		}
	}
}

// A library imported after the store opened with no file is read without a
// restart.
func TestStoreReadsALibraryImportedAfterOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "library.db")
	s := openLibraryStore(t, path)
	writeLibraryFile(t, path, "canonical_imported")
	if _, ok, err := s.AttributionGet(t.Context(), "canonical_imported"); err != nil || !ok {
		t.Fatalf("imported library not read: %v %v", ok, err)
	}
}

// The store's own writes, checkpointed into the file, are not a replacement:
// the handle stays the same.
func TestStoreKeepsItsHandleAcrossItsOwnWrites(t *testing.T) {
	ctx := t.Context()
	s := openLibraryStore(t, filepath.Join(t.TempDir(), "library.db"))
	if err := s.AttributionCreate(ctx, "canonical_a", library.AttrPinned, "en", "a"); err != nil {
		t.Fatal(err)
	}
	s.mu.RLock()
	before := s.repo
	s.mu.RUnlock()
	if _, err := s.Snapshot(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.AttributionCreate(ctx, "canonical_b", library.AttrPinned, "en", "b"); err != nil {
		t.Fatal(err)
	}
	s.mu.RLock()
	after := s.repo
	s.mu.RUnlock()
	if before != after {
		t.Fatal("store reopened the library after its own writes")
	}
}
