package sqlitelibrary

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

func TestStoreCreatesTheLibraryOnFirstWrite(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "nested", "library.db")
	s, err := OpenStore(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})

	if _, _, err := s.AttributionGet(ctx, "canonical_x"); !errors.Is(err, ErrNoLibrary) {
		t.Fatalf("read before any write: %v, want ErrNoLibrary", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a read created the file (stat: %v)", err)
	}

	if err := s.AttributionCreate(ctx, "canonical_x", library.AttrPinned, "ru", "что такое разум"); err != nil {
		t.Fatalf("first write: %v", err)
	}
	a, ok, err := s.AttributionGet(ctx, "canonical_x")
	if err != nil || !ok || a.Kind != library.AttrPinned {
		t.Fatalf("read back: %+v %v %v", a, ok, err)
	}
}
