package runmirror

import (
	"context"
	"errors"
	"io"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/jiva-studio/lectorium-storage-sync/internal/domain/mirror"
)

// --- fakes (the ports make these cheap) ---

type fakeSource struct {
	objs    map[string]mirror.Object
	bodies  map[string]string
	statErr error
	opened  []string
	mu      sync.Mutex
}

func newSource() *fakeSource {
	return &fakeSource{objs: map[string]mirror.Object{}, bodies: map[string]string{}}
}

func (f *fakeSource) add(key, sha string, size int64, body string) {
	f.objs[key] = mirror.Object{Key: key, Size: size, SHA256: sha}
	f.bodies[key] = body
}

func (f *fakeSource) Walk(_ context.Context, _ string) (map[string]mirror.Object, error) {
	out := make(map[string]mirror.Object, len(f.objs))
	for k, v := range f.objs {
		out[k] = v
	}
	return out, nil
}

func (f *fakeSource) Stat(_ context.Context, key string) (mirror.Object, bool, error) {
	if f.statErr != nil {
		return mirror.Object{}, false, f.statErr
	}
	o, ok := f.objs[key]
	return o, ok, nil
}

func (f *fakeSource) Open(_ context.Context, key string) (io.ReadCloser, string, error) {
	b, ok := f.bodies[key]
	if !ok {
		return nil, "", errors.New("no body")
	}
	f.mu.Lock()
	f.opened = append(f.opened, key)
	f.mu.Unlock()
	return io.NopCloser(strings.NewReader(b)), "audio/mpeg", nil
}

type putRecord struct {
	key, sha, body string
}

type fakeMirror struct {
	mu      sync.Mutex
	state   map[string]mirror.MirrorState
	puts    []putRecord
	deleted []string
	keys    []string
}

func newMirror() *fakeMirror {
	return &fakeMirror{state: map[string]mirror.MirrorState{}}
}

func (f *fakeMirror) have(key, sha string, size int64) {
	f.state[key] = mirror.MirrorState{Exists: true, Size: size, SHA256: sha}
}

func (f *fakeMirror) State(_ context.Context, key string) (mirror.MirrorState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state[key], nil
}

func (f *fakeMirror) Put(_ context.Context, obj mirror.Object, body io.Reader, _ string) error {
	b, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts = append(f.puts, putRecord{key: obj.Key, sha: obj.SHA256, body: string(b)})
	f.state[obj.Key] = mirror.MirrorState{Exists: true, Size: obj.Size, SHA256: obj.SHA256}
	return nil
}

func (f *fakeMirror) ListKeys(_ context.Context, _ string) ([]string, error) {
	return f.keys, nil
}

func (f *fakeMirror) DeleteKeys(_ context.Context, keys []string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, keys...)
	return len(keys), nil
}

func (f *fakeMirror) putKeys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.puts))
	for _, p := range f.puts {
		out = append(out, p.key)
	}
	sort.Strings(out)
	return out
}

const (
	audioKey = "public/tracks/h1/audio/original.mp3"
	transKey = "public/tracks/h1/transcripts/en.json"
)

func readyEvent() mirror.TrackReady {
	return mirror.TrackReady{TrackID: "h1", AudioKey: audioKey, TranscriptKey: transKey}
}

// --- tests ---

// The whole point of the fast path: both blobs reach the mirror right away,
// carrying the source checksum as the stamp a later pass compares against.
func TestSyncTrackCopiesBothBlobs(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	src.add(transKey, "sha-trans", 20, "TRANSCRIPT")
	s := New(Deps{Source: src, Mirror: dst})

	copied, err := s.SyncTrack(t.Context(), readyEvent())
	if err != nil {
		t.Fatalf("SyncTrack: %v", err)
	}
	if copied != 2 {
		t.Fatalf("copied = %d, want 2", copied)
	}
	got := dst.putKeys()
	if len(got) != 2 || got[0] != audioKey || got[1] != transKey {
		t.Fatalf("put keys = %v", got)
	}
	for _, p := range dst.puts {
		if p.sha == "" {
			t.Errorf("%s stored without a checksum stamp", p.key)
		}
	}
}

// A redelivered event (or an object the periodic pass already shipped) must be
// a cheap no-op — this is what makes at-least-once delivery safe.
func TestSyncTrackIsIdempotent(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	src.add(transKey, "sha-trans", 20, "TRANSCRIPT")
	dst.have(audioKey, "sha-audio", 100)
	dst.have(transKey, "sha-trans", 20)
	s := New(Deps{Source: src, Mirror: dst})

	copied, err := s.SyncTrack(t.Context(), readyEvent())
	if err != nil {
		t.Fatalf("SyncTrack: %v", err)
	}
	if copied != 0 {
		t.Fatalf("copied = %d, want 0 (already mirrored)", copied)
	}
	if len(dst.puts) != 0 {
		t.Fatalf("nothing should have been written, got %v", dst.putKeys())
	}
}

// A stale mirror copy (same key, different content) must be re-shipped.
func TestSyncTrackReshipsChangedContent(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-new", 100, "AUDIO")
	dst.have(audioKey, "sha-old", 100) // same size, different checksum
	s := New(Deps{Source: src, Mirror: dst})

	copied, err := s.SyncKeys(t.Context(), []string{audioKey})
	if err != nil {
		t.Fatalf("SyncKeys: %v", err)
	}
	if copied != 1 {
		t.Fatalf("copied = %d, want 1", copied)
	}
}

// A key the source listing does not (yet) show is skipped and left to the next
// full pass — it must NOT fail the message forever.
func TestSyncTrackSkipsMissingSourceObject(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO") // transcript absent
	s := New(Deps{Source: src, Mirror: dst})

	copied, err := s.SyncTrack(t.Context(), readyEvent())
	if err != nil {
		t.Fatalf("a missing source object must not error, got %v", err)
	}
	if copied != 1 {
		t.Fatalf("copied = %d, want 1 (audio only)", copied)
	}
}

// A source read failure IS an error, so the consumer leaves the message pending
// and the reclaim retries it.
func TestSyncTrackPropagatesSourceError(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.statErr = errors.New("bunny down")
	s := New(Deps{Source: src, Mirror: dst})

	if _, err := s.SyncTrack(t.Context(), readyEvent()); err == nil {
		t.Fatal("expected the source error to propagate so the event is retried")
	}
}

// DryRun decides everything but writes nothing.
func TestSyncTrackDryRun(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	s := New(Deps{Source: src, Mirror: dst, DryRun: true})

	if _, err := s.SyncKeys(t.Context(), []string{audioKey}); err != nil {
		t.Fatalf("SyncKeys: %v", err)
	}
	if len(dst.puts) != 0 {
		t.Fatalf("dry run must not write, got %v", dst.putKeys())
	}
}

// The reconciler ships what is missing and, when pruning is on, removes mirror
// objects the source no longer has.
func TestFullPassCopiesAndPrunes(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	dst.keys = []string{audioKey, "public/tracks/gone/audio/original.mp3"}
	s := New(Deps{Source: src, Mirror: dst, Prune: true, Concurrency: 4})

	res, err := s.FullPass(t.Context())
	if err != nil {
		t.Fatalf("FullPass: %v", err)
	}
	if res.Source != 1 || res.Copied != 1 {
		t.Fatalf("result = %+v, want 1 source / 1 copied", res)
	}
	if len(dst.deleted) != 1 || dst.deleted[0] != "public/tracks/gone/audio/original.mp3" {
		t.Fatalf("prune deleted %v, want only the orphan", dst.deleted)
	}
}

// A targeted sync has not observed the whole source, so it must never delete.
func TestSyncKeysNeverPrunes(t *testing.T) {
	src, dst := newSource(), newMirror()
	src.add(audioKey, "sha-audio", 100, "AUDIO")
	dst.keys = []string{"public/tracks/other/audio/original.mp3"}
	s := New(Deps{Source: src, Mirror: dst, Prune: true})

	if _, err := s.SyncKeys(t.Context(), []string{audioKey}); err != nil {
		t.Fatalf("SyncKeys: %v", err)
	}
	if len(dst.deleted) != 0 {
		t.Fatalf("targeted sync must not delete, got %v", dst.deleted)
	}
}
