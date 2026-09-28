package sqlitecatalog

import (
	"path/filepath"
	"testing"
)

// newTestRepo opens a fresh catalog file with the published schema.
func newTestRepo(t *testing.T) (*Repo, func()) {
	t.Helper()
	r, err := Open(t.Context(), filepath.Join(t.TempDir(), "current.db"))
	if err != nil {
		t.Fatalf("open catalog: %v", err)
	}
	return r, func() {
		if err := r.Close(); err != nil {
			t.Errorf("close catalog: %v", err)
		}
	}
}
