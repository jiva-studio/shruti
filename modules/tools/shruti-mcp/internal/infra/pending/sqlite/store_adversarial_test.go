package sqlitepending

import (
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pending"
)

// A swap whose source is gone must leave the live queue readable.
func TestInstallOfAMissingSourceKeepsTheQueue(t *testing.T) {
	ctx := t.Context()
	s, err := OpenStore(ctx, filepath.Join(t.TempDir(), "pending.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	r, release, err := s.acquire()
	if err != nil {
		t.Fatal(err)
	}
	seed(t, r, pending.Track{TrackID: "trk_keep", OwnerID: "o", Lang: "ru", CreatedAt: "2026-01-01T00:00:00Z"})
	release()

	if err := s.Install(ctx, filepath.Join(t.TempDir(), "missing.db")); err == nil {
		t.Fatal("install of a missing source succeeded")
	}
	if _, ok, err := s.Get(ctx, "trk_keep"); err != nil || !ok {
		t.Fatalf("queue lost after a failed install: %v %v", ok, err)
	}
}
