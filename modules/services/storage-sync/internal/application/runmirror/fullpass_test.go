package runmirror

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
)

const (
	configKey  = "public/config.json"
	pendingKey = "public/db/pending.db"
	deepEvery  = 24 * time.Hour
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time { return c.now }

func (c *fakeClock) advance(d time.Duration) { c.now = c.now.Add(d) }

func mustScope(t *testing.T, exclude, mutable []string) mirror.Scope {
	t.Helper()
	sc, err := mirror.NewScope(exclude, mutable)
	if err != nil {
		t.Fatalf("NewScope: %v", err)
	}
	return sc
}

// newPrimed builds a service whose deep pass has just run over an empty source,
// then moves the clock an hour on, so the next FullPass is a regular one.
func newPrimed(t *testing.T, src *fakeSource, dst *fakeMirror, sc mirror.Scope) (*Service, *fakeClock) {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	saved := src.objs
	src.objs = map[string]mirror.Object{}
	s := New(Deps{Source: src, Mirror: dst, Scope: sc, DeepEvery: deepEvery, Now: clock.Now, Concurrency: 4})
	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("priming pass: %v", err)
	}
	if !res.Deep {
		t.Fatalf("the first pass must be deep, got %+v", res)
	}
	src.objs = saved
	dst.resetCounts()
	clock.advance(time.Hour)
	return s, clock
}

func TestRegularPassSkipsSameSizeObjectWithoutHead(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-new", 100, "AUDIO")
	dst.have(audioKey, "sha-old", 100)
	s, _ := newPrimed(t, src, dst, mustScope(t, nil, []string{configKey}))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if res.Deep {
		t.Fatal("a pass an hour after a deep pass must be regular")
	}
	if res.Copied != 0 || len(dst.puts) != 0 {
		t.Fatalf("same-size object was copied: %+v, puts %v", res, dst.putKeys())
	}
	if dst.heads() != 0 || res.Heads != 0 {
		t.Fatalf("regular pass issued %d HEADs (reported %d), want 0", dst.heads(), res.Heads)
	}
}

func TestRegularPassCopiesObjectWhoseSizeDiffers(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-new", 120, "AUDIO-LONGER")
	dst.have(audioKey, "sha-old", 100)
	s, _ := newPrimed(t, src, dst, mustScope(t, nil, nil))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if res.Copied != 1 || !slices.Equal(dst.putKeys(), []string{audioKey}) {
		t.Fatalf("size-differing object not copied: %+v, puts %v", res, dst.putKeys())
	}
	if dst.heads() != 0 {
		t.Fatalf("a size difference needs no HEAD, got %d", dst.heads())
	}
}

func TestRegularPassCopiesObjectMissingFromListing(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	s, _ := newPrimed(t, src, dst, mustScope(t, nil, nil))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if res.Copied != 1 || dst.heads() != 0 {
		t.Fatalf("missing object: copied %d with %d HEADs, want 1 with 0", res.Copied, dst.heads())
	}
}

func TestMutableKeyIsComparedByChecksumEveryPass(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(configKey, "sha-new", 50, "CONFIG")
	src.add(pendingKey, "sha-pending", 70, "PENDING")
	dst.have(configKey, "sha-old", 50)
	dst.have(pendingKey, "sha-pending", 70)
	s, clock := newPrimed(t, src, dst, mustScope(t, nil, []string{configKey, pendingKey}))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if !slices.Equal(dst.putKeys(), []string{configKey}) {
		t.Fatalf("puts = %v, want only the changed mutable key", dst.putKeys())
	}
	if res.Heads != 2 || dst.heads() != 2 {
		t.Fatalf("HEADs = %d (reported %d), want one per mutable key", dst.heads(), res.Heads)
	}

	dst.resetCounts()
	clock.advance(time.Hour)
	if _, err := s.FullPass(t.Context()); err != nil {
		t.Fatalf("second FullPass: %v", err)
	}
	if dst.heads() != 2 {
		t.Fatalf("mutable keys must be checked on every pass, got %d HEADs", dst.heads())
	}
	if len(dst.puts) != 0 {
		t.Fatalf("unchanged mutable keys re-copied: %v", dst.putKeys())
	}
}

func TestRegularPassHeadsAreBoundedByMutableKeys(t *testing.T) {
	src, dst := newSource(), newMirror()
	for i := range 200 {
		key := fmt.Sprintf("public/tracks/t%03d/audio/original.mp3", i)
		src.add(key, "sha", 10, "0123456789")
		dst.have(key, "sha", 10)
	}
	src.add(configKey, "sha-c", 5, "CONF!")
	dst.have(configKey, "sha-c", 5)
	src.add(pendingKey, "sha-p", 5, "PEND!")
	dst.have(pendingKey, "sha-p", 5)
	s, _ := newPrimed(t, src, dst, mustScope(t, nil, []string{configKey, pendingKey, "public/never/*"}))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if dst.heads() > 2 {
		t.Fatalf("regular pass issued %d HEADs over %d objects, want at most the 2 mutable keys",
			dst.heads(), res.Source)
	}
	if res.Listed != 202 {
		t.Fatalf("Listed = %d, want 202", res.Listed)
	}
}

func TestDeepPassRunsFirstThenOnItsOwnCadence(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-new", 100, "AUDIO")
	src.add(transKey, "sha-t", 20, "TRANSCRIPT")
	dst.have(transKey, "sha-t", 20)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s := New(Deps{Source: src, Mirror: dst, DeepEvery: deepEvery, Now: clock.Now})

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("first FullPass: %v", err)
	}
	if !res.Deep || dst.heads() != 1 {
		t.Fatalf("first pass: deep=%v heads=%d, want a deep pass checking the listed object", res.Deep, dst.heads())
	}

	// Same size, new content, not mutable: invisible to regular passes.
	dst.have(audioKey, "sha-old", 100)
	dst.resetCounts()
	for range 23 {
		clock.advance(time.Hour)
		res, err = s.FullPass(t.Context())
		if err != nil {
			t.Fatalf("regular FullPass: %v", err)
		}
		if res.Deep {
			t.Fatalf("pass at +%s was deep; the deep pass runs once per %s", clock.now.Sub(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)), deepEvery)
		}
	}
	if dst.heads() != 0 || len(dst.puts) != 0 {
		t.Fatalf("regular passes: %d HEADs, puts %v; want none", dst.heads(), dst.putKeys())
	}

	clock.advance(time.Hour)
	res, err = s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("deep FullPass: %v", err)
	}
	if !res.Deep {
		t.Fatal("the pass one deep interval after the last deep pass must be deep")
	}
	if !slices.Equal(dst.putKeys(), []string{audioKey}) {
		t.Fatalf("deep pass puts = %v, want the same-size changed object", dst.putKeys())
	}
}

func TestZeroDeepIntervalMakesEveryPassDeep(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-new", 100, "AUDIO")
	dst.have(audioKey, "sha-old", 100)
	s := New(Deps{Source: src, Mirror: dst})

	for i := range 2 {
		dst.have(audioKey, "sha-old", 100)
		dst.resetCounts()
		res, err := s.FullPass(t.Context())
		if err != nil {
			t.Fatalf("FullPass %d: %v", i, err)
		}
		if !res.Deep || res.Copied != 1 {
			t.Fatalf("pass %d: %+v, want a deep pass that ships the same-size change", i, res)
		}
	}
}

func TestExcludedPrefixesAreNeitherCopiedNorPruned(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add("private/src-only.bin", "sha-p", 9, "PRIVATE!!")
	src.add(audioKey, "sha-a", 5, "AUDIO")
	dst.have("private/mirror-only.bin", "sha-m", 3)
	dst.have("public/tracks/gone/audio/original.mp3", "sha-g", 4)
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	s := New(Deps{
		Source: src, Mirror: dst, Prune: true,
		Scope:     mustScope(t, []string{"private/"}, nil),
		DeepEvery: deepEvery, Now: clock.Now,
	})

	for _, deep := range []bool{true, false} {
		res, err := s.FullPass(t.Context())
		if err != nil {
			t.Fatalf("FullPass: %v", err)
		}
		if res.Deep != deep {
			t.Fatalf("deep = %v, want %v", res.Deep, deep)
		}
		for _, k := range dst.putKeys() {
			if k == "private/src-only.bin" {
				t.Fatalf("excluded key copied (deep=%v)", deep)
			}
		}
		if slices.Contains(dst.deleted, "private/mirror-only.bin") {
			t.Fatalf("excluded key pruned (deep=%v): %v", deep, dst.deleted)
		}
		clock.advance(time.Hour)
	}
	if !slices.Contains(dst.deleted, "public/tracks/gone/audio/original.mp3") {
		t.Fatalf("prune must still remove non-excluded orphans, deleted %v", dst.deleted)
	}
	if !slices.Contains(dst.putKeys(), audioKey) {
		t.Fatalf("non-excluded object must still be copied, puts %v", dst.putKeys())
	}
}

func TestEmptyScopeMirrorsAndPrunesEveryPrefix(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add("private/src-only.bin", "sha-p", 9, "PRIVATE!!")
	dst.have("private/mirror-only.bin", "sha-m", 3)
	s := New(Deps{Source: src, Mirror: dst, Prune: true})

	if _, err := s.FullPass(t.Context()); err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if !slices.Equal(dst.putKeys(), []string{"private/src-only.bin"}) {
		t.Fatalf("puts = %v, want the private object", dst.putKeys())
	}
	if !slices.Equal(dst.deleted, []string{"private/mirror-only.bin"}) {
		t.Fatalf("deleted = %v, want the private orphan", dst.deleted)
	}
}

func TestPassReportsItsCounters(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-a", 100, "AUDIO")
	src.add(transKey, "sha-t", 20, "TRANSCRIPT")
	src.add(configKey, "sha-c", 5, "CONF!")
	dst.have(configKey, "sha-c", 5)
	dst.have(transKey, "sha-t", 19)
	dst.have("public/other.bin", "sha-o", 1)
	s, _ := newPrimed(t, src, dst, mustScope(t, nil, []string{configKey}))

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	want := PassResult{Source: 3, Listed: 3, Heads: 1, Copied: 2, Bytes: 120}
	if res != want {
		t.Fatalf("result = %+v, want %+v", res, want)
	}
}
