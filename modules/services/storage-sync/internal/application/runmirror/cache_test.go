package runmirror

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
)

func newClocked(src *fakeSource, dst *fakeMirror, sc mirror.Scope) (*Service, *fakeClock) {
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return New(Deps{Source: src, Mirror: dst, Scope: sc, DeepEvery: deepEvery, Now: clock.Now, Concurrency: 4}), clock
}

func runPass(t *testing.T, s *Service) PassResult {
	t.Helper()
	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	return res
}

func TestSameSizeRewriteOfCopiedObjectIsCaughtOnNextRegularPassWithoutHead(t *testing.T) {
	src, dst := newSource(), newMirror()
	const cleanKey = "public/tracks/h1/audio/clean.mp3"
	src.add(cleanKey, "sha-v1", 100, "CLEAN-V1")
	s, clock := newClocked(src, dst, mirror.Scope{})
	if res := runPass(t, s); !res.Deep || res.Copied != 1 {
		t.Fatalf("first pass = %+v, want a deep pass copying the object", res)
	}

	src.add(cleanKey, "sha-v2", 100, "CLEAN-V2")
	dst.resetCounts()
	clock.advance(time.Hour)
	res := runPass(t, s)
	if res.Deep {
		t.Fatal("second pass must be regular")
	}
	if !slices.Equal(dst.putKeys(), []string{cleanKey}) {
		t.Fatalf("same-size rewrite not re-shipped: puts %v", dst.putKeys())
	}
	if dst.heads() != 0 {
		t.Fatalf("detecting the rewrite cost %d HEADs, want 0", dst.heads())
	}
}

func TestDeepPassRecordsMirrorChecksumsForLaterPasses(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(transKey, "sha-v1", 20, "TRANSCRIPT")
	dst.have(transKey, "sha-v1", 20)
	s, clock := newClocked(src, dst, mirror.Scope{})
	if res := runPass(t, s); !res.Deep || res.Copied != 0 || res.Heads != 1 {
		t.Fatalf("first pass = %+v, want a deep pass that inspects and keeps the object", res)
	}

	src.add(transKey, "sha-v2", 20, "TRANSCRIPU")
	dst.resetCounts()
	clock.advance(time.Hour)
	runPass(t, s)
	if !slices.Equal(dst.putKeys(), []string{transKey}) || dst.heads() != 0 {
		t.Fatalf("regular pass: puts %v with %d HEADs, want the rewrite shipped with 0", dst.putKeys(), dst.heads())
	}
}

func TestFastPathCopyUpdatesTheChecksumCache(t *testing.T) {
	src, dst := newSource(), newMirror()
	s, clock := newClocked(src, dst, mirror.Scope{})
	runPass(t, s)

	src.add(audioKey, "sha-v1", 100, "AUDIO-V1")
	if n, err := s.SyncKeys(t.Context(), []string{audioKey}); err != nil || n != 1 {
		t.Fatalf("SyncKeys = %d, %v", n, err)
	}
	src.add(audioKey, "sha-v2", 100, "AUDIO-V2")
	dst.resetCounts()
	clock.advance(time.Hour)
	runPass(t, s)
	if !slices.Equal(dst.putKeys(), []string{audioKey}) || dst.heads() != 0 {
		t.Fatalf("regular pass: puts %v with %d HEADs, want the rewrite shipped with 0", dst.putKeys(), dst.heads())
	}
}

func TestRestartStartsWithADeepPass(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-v1", 100, "AUDIO-V1")
	s, _ := newClocked(src, dst, mirror.Scope{})
	runPass(t, s)

	src.add(audioKey, "sha-v2", 100, "AUDIO-V2")
	dst.resetCounts()
	restarted, _ := newClocked(src, dst, mirror.Scope{})
	res := runPass(t, restarted)
	if !res.Deep || res.Heads != 1 {
		t.Fatalf("first pass after restart = %+v, want deep with one HEAD", res)
	}
	if !slices.Equal(dst.putKeys(), []string{audioKey}) {
		t.Fatalf("rewrite during downtime not shipped: %v", dst.putKeys())
	}
}

func TestUnstampedLegacyObjectIsNotReshippedByRegularPasses(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-a", 100, "AUDIO")
	dst.have(audioKey, "", 100)
	s, clock := newClocked(src, dst, mirror.Scope{})
	runPass(t, s)
	for range 3 {
		clock.advance(time.Hour)
		runPass(t, s)
	}
	if len(dst.puts) != 0 {
		t.Fatalf("legacy same-size object re-shipped: %v", dst.putKeys())
	}
}

func TestPersistentFailureDoesNotKeepPassesDeep(t *testing.T) {
	src, dst := newSource(), newMirror()
	for i := range 1000 {
		key := fmt.Sprintf("public/tracks/t%04d/audio/original.mp3", i)
		src.add(key, "sha", 10, "0123456789")
		dst.have(key, "sha", 10)
	}
	const broken = "public/tracks/broken/audio/original.mp3"
	src.add(broken, "sha-b", 5, "BROKE")
	dst.putErr[broken] = errors.New("mirror refuses the write")
	s, clock := newClocked(src, dst, mirror.Scope{})

	for i := range 4 {
		dst.resetCounts()
		res, err := s.FullPass(t.Context())
		if err == nil {
			t.Fatalf("pass %d: a failing object must still report the pass as failed", i)
		}
		if res.Deep != (i == 0) {
			t.Fatalf("pass %d: deep = %v; only the first pass may be deep", i, res.Deep)
		}
		if i > 0 && dst.heads() > 1 {
			t.Fatalf("pass %d issued %d HEADs, want at most one for the retried key", i, dst.heads())
		}
		if res.Retrying != 1 {
			t.Fatalf("pass %d: Retrying = %d, want 1", i, res.Retrying)
		}
		clock.advance(time.Hour)
	}
}

func TestFailedInspectionIsRetriedOnTheNextPassOnly(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha", 100, "AUDIO")
	dst.have(audioKey, "sha-old", 100)
	dst.stateErr[audioKey] = errors.New("mirror 503")
	s, clock := newClocked(src, dst, mirror.Scope{})

	res, err := s.FullPass(t.Context())
	if err == nil || !res.Deep {
		t.Fatalf("first pass = %+v, %v; want a deep pass reporting the failed read", res, err)
	}

	delete(dst.stateErr, audioKey)
	dst.resetCounts()
	clock.advance(time.Hour)
	res = runPass(t, s)
	if res.Deep {
		t.Fatal("a failed read must not make the next pass deep")
	}
	if dst.heads() != 1 || !slices.Equal(dst.putKeys(), []string{audioKey}) {
		t.Fatalf("retry: %d HEADs, puts %v; want the key re-read and shipped", dst.heads(), dst.putKeys())
	}
	if res.Retrying != 0 {
		t.Fatalf("Retrying = %d after the key recovered, want 0", res.Retrying)
	}

	dst.resetCounts()
	clock.advance(time.Hour)
	runPass(t, s)
	if dst.heads() != 0 {
		t.Fatalf("a recovered key is still re-read: %d HEADs", dst.heads())
	}
}

func TestChecksumRecordDropsKeysGoneFromTheSource(t *testing.T) {
	src, dst := newSource(), newMirror()
	const goneKey = "public/tracks/gone/audio/original.mp3"
	src.add(audioKey, "sha-a", 5, "AUDIO")
	src.add(goneKey, "sha-g", 4, "GONE")
	s, clock := newClocked(src, dst, mirror.Scope{})
	runPass(t, s)
	if _, ok := s.held[goneKey]; !ok {
		t.Fatal("setup: the copied key must be recorded")
	}

	delete(src.objs, goneKey)
	clock.advance(time.Hour)
	runPass(t, s)
	if _, ok := s.held[goneKey]; ok {
		t.Fatal("a key gone from the source is still in the checksum record")
	}
	if _, ok := s.held[audioKey]; !ok {
		t.Fatal("a key still on the source was dropped from the checksum record")
	}
}

func TestEventPathSkipsExcludedKeys(t *testing.T) {
	src, dst := newSource(), newMirror()
	const privateKey = "private/tracks/h1/audio/original.mp3"
	src.add(privateKey, "sha", 5, "SECRT")
	src.add(audioKey, "sha-a", 5, "AUDIO")
	sc, err := mirror.NewScope([]string{"private/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Source: src, Mirror: dst, Scope: sc})

	n, err := s.SyncKeys(t.Context(), []string{privateKey, audioKey})
	if err != nil {
		t.Fatalf("SyncKeys: %v", err)
	}
	if n != 1 || !slices.Equal(dst.putKeys(), []string{audioKey}) {
		t.Fatalf("copied %d, puts %v; want only the non-excluded key", n, dst.putKeys())
	}
}
