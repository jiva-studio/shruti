package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
	"github.com/jiva-studio/lectorium/orchestrator/internal/infra/review"
	"github.com/jiva-studio/lectorium/orchestrator/internal/ports"
)

// --- fakes (the hexagonal design makes these cheap) ---

type fakeRepo struct {
	mu   sync.Mutex
	jobs map[string]job.Job
}

func newRepo() *fakeRepo { return &fakeRepo{jobs: map[string]job.Job{}} }

func (r *fakeRepo) Create(_ context.Context, j *job.Job) error       { return r.put(j) }
func (r *fakeRepo) CreateTx(_ context.Context, _ ports.Tx, j *job.Job) error { return r.put(j) }
func (r *fakeRepo) Save(_ context.Context, j *job.Job) error         { return r.put(j) }
func (r *fakeRepo) SaveTx(_ context.Context, _ ports.Tx, j *job.Job) error   { return r.put(j) }

func (r *fakeRepo) put(j *job.Job) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.jobs[j.ID] = *j // store a value copy — the caller keeps mutating j
	return nil
}

func (r *fakeRepo) Get(_ context.Context, id string) (*job.Job, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j, ok := r.jobs[id]
	if !ok {
		return nil, nil
	}
	cp := j
	return &cp, nil
}

func (r *fakeRepo) WithTx(ctx context.Context, fn func(ports.Tx) error) error { return fn(nil) }

type fakeEvents struct {
	mu   sync.Mutex
	list []ingest.TrackEvent
}

func (e *fakeEvents) Publish(_ context.Context, _ ports.Tx, _ string, payload []byte) error {
	var ev ingest.TrackEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, ev)
	return nil
}

func (e *fakeEvents) types() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]string, len(e.list))
	for i, ev := range e.list {
		out[i] = ev.Type
	}
	return out
}

// fakeFetcher writes `content` to a fresh temp dir and returns its path + the
// real content hash, so runingest's os.ReadFile / content-addressing is
// exercised end-to-end.
type fakeFetcher struct {
	content []byte
	err     error
	calls   int
}

func (f *fakeFetcher) Fetch(_ context.Context, _ string) (string, string, error) {
	f.calls++
	if f.err != nil {
		return "", "", f.err
	}
	dir, err := os.MkdirTemp("", "fakefetch-*")
	if err != nil {
		return "", "", err
	}
	p := filepath.Join(dir, "audio.mp3")
	if err := os.WriteFile(p, f.content, 0o600); err != nil {
		return "", "", err
	}
	return p, ingest.ContentID(f.content), nil
}

type fakeTranscriber struct {
	lang  string
	err   error
	calls int
}

func (t *fakeTranscriber) Transcribe(_ context.Context, _ string) ([]byte, string, error) {
	t.calls++
	if t.err != nil {
		return nil, "", t.err
	}
	return []byte(`{"segments":[]}`), t.lang, nil
}

type fakeBlob struct {
	mu       sync.Mutex
	objects  map[string][]byte
	existsNo bool // when true, Exists always reports false (HEAD-verify failure)
}

func newBlob() *fakeBlob { return &fakeBlob{objects: map[string][]byte{}} }

func (b *fakeBlob) Put(_ context.Context, key string, body []byte, _ string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.objects[key] = body
	return nil
}

func (b *fakeBlob) Exists(_ context.Context, key string) (bool, error) {
	if b.existsNo {
		return false, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.objects[key]
	return ok, nil
}

type fakeTier struct {
	userID string
	pro    bool
	err    error
}

func (t fakeTier) VerifyPro(string) (string, bool, error) { return t.userID, t.pro, t.err }

// --- harness ---

type harness struct {
	repo   *fakeRepo
	events *fakeEvents
	fetch  *fakeFetcher
	trans  *fakeTranscriber
	blob   *fakeBlob
	tier   fakeTier
	svc    *Service
}

func newHarness(maxAttempts int) *harness {
	h := &harness{
		repo:   newRepo(),
		events: &fakeEvents{},
		fetch:  &fakeFetcher{content: []byte("audio-bytes")},
		trans:  &fakeTranscriber{lang: "en"},
		blob:   newBlob(),
		tier:   fakeTier{userID: "user-1", pro: true},
	}
	h.build(maxAttempts)
	return h
}

func (h *harness) build(maxAttempts int) {
	h.svc = New(Deps{
		Repo:              h.repo,
		Events:            h.events,
		Fetcher:           h.fetch,
		Transcriber:       h.trans,
		Reviewer:          review.New(),
		Blob:              h.blob,
		Tier:              h.tier,
		MaxAttempts:       maxAttempts,
		TrackEventsStream: "track.events",
	})
}

func reqPayload(t *testing.T, url string) []byte {
	t.Helper()
	b, err := json.Marshal(ingest.Request{URL: url, Token: "tok", Title: "A talk"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// --- tests ---

func TestProcess_HappyPath(t *testing.T) {
	h := newHarness(3)
	if err := h.svc.Process(context.Background(), "msg-1", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process: %v", err)
	}

	j, _ := h.repo.Get(context.Background(), jobIDFor("msg-1"))
	if j == nil || j.State != job.StateDone {
		t.Fatalf("job not done: %+v", j)
	}
	if j.TrackID != ingest.ContentID([]byte("audio-bytes")) {
		t.Fatalf("track id mismatch: %q", j.TrackID)
	}
	// audio + transcript stored under the content-addressed prefix
	if _, ok := h.blob.objects["public/tracks/"+j.TrackID+"/audio"]; !ok {
		t.Fatal("audio not stored")
	}
	if _, ok := h.blob.objects["public/tracks/"+j.TrackID+"/transcript"]; !ok {
		t.Fatal("transcript not stored")
	}
	want := []string{ingest.EventQueued, ingest.EventProcessing, ingest.EventReady}
	if got := h.events.types(); !equal(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

func TestProcess_NotPro_PermanentFail(t *testing.T) {
	h := newHarness(3)
	h.tier = fakeTier{userID: "user-1", pro: false}
	h.build(3)

	if err := h.svc.Process(context.Background(), "msg-2", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process should ack (nil), got %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobIDFor("msg-2"))
	if j == nil || j.State != job.StateFailed {
		t.Fatalf("job not failed: %+v", j)
	}
	if h.fetch.calls != 0 {
		t.Fatalf("fetcher should not run for non-pro, calls=%d", h.fetch.calls)
	}
	if last := lastType(h.events.types()); last != ingest.EventFailed {
		t.Fatalf("last event = %q, want track.failed", last)
	}
}

func TestProcess_TransientRetryThenDeadLetter(t *testing.T) {
	h := newHarness(2)
	h.fetch = &fakeFetcher{err: errors.New("boom")}
	h.build(2)

	// Attempt 1: transient failure → error returned (message left pending).
	if err := h.svc.Process(context.Background(), "msg-3", reqPayload(t, "https://x/y")); err == nil {
		t.Fatal("attempt 1 should return an error (nack)")
	}
	j, _ := h.repo.Get(context.Background(), jobIDFor("msg-3"))
	if j.State != job.StateRunning || j.Attempts != 1 {
		t.Fatalf("after attempt 1: state=%s attempts=%d", j.State, j.Attempts)
	}

	// Attempt 2 (redelivery): reaches the cap → dead-letter, acked (nil).
	if err := h.svc.Process(context.Background(), "msg-3", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("attempt 2 should dead-letter (nil), got %v", err)
	}
	j, _ = h.repo.Get(context.Background(), jobIDFor("msg-3"))
	if j.State != job.StateFailed || j.Attempts != 2 {
		t.Fatalf("after dead-letter: state=%s attempts=%d", j.State, j.Attempts)
	}
	if lastType(h.events.types()) != ingest.EventFailed {
		t.Fatalf("expected a track.failed event, got %v", h.events.types())
	}

	// A further redelivery of a settled job is a no-op ack.
	if err := h.svc.Process(context.Background(), "msg-3", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("settled redelivery should ack, got %v", err)
	}
}

func TestProcess_HeadVerifyFailureRetries(t *testing.T) {
	h := newHarness(3)
	h.blob = newBlob()
	h.blob.existsNo = true // artifacts "vanish" — HEAD-verify fails
	h.build(3)

	if err := h.svc.Process(context.Background(), "msg-4", reqPayload(t, "https://x/y")); err == nil {
		t.Fatal("HEAD-verify failure should nack (return error)")
	}
	j, _ := h.repo.Get(context.Background(), jobIDFor("msg-4"))
	if j.State == job.StateDone {
		t.Fatal("job must not be done when HEAD-verify fails")
	}
}

// TestContentHashDedup: two DIFFERENT requests carrying identical audio collapse
// onto one track — the second claims-fails and skips transcription.
func TestContentHashDedup(t *testing.T) {
	h := newHarness(3)

	if err := h.svc.Process(context.Background(), "msg-a", reqPayload(t, "https://x/a")); err != nil {
		t.Fatalf("first ingest: %v", err)
	}
	// Second message, distinct job, SAME audio content (same fetcher content).
	if err := h.svc.Process(context.Background(), "msg-b", reqPayload(t, "https://x/b")); err != nil {
		t.Fatalf("second ingest: %v", err)
	}

	hash := ingest.ContentID([]byte("audio-bytes"))
	jb, _ := h.repo.Get(context.Background(), jobIDFor("msg-b"))
	if jb.State != job.StateDone || jb.TrackID != hash {
		t.Fatalf("deduped job not done onto shared track: %+v", jb)
	}
	// Transcriber ran only for the FIRST job; the dedup path skipped it.
	if h.trans.calls != 1 {
		t.Fatalf("transcriber calls = %d, want 1 (dedup should skip)", h.trans.calls)
	}
}

func TestContentID_Deterministic(t *testing.T) {
	a := ingest.ContentID([]byte("same"))
	b := ingest.ContentID([]byte("same"))
	c := ingest.ContentID([]byte("different"))
	if a != b {
		t.Fatal("ContentID not deterministic for identical bytes")
	}
	if a == c {
		t.Fatal("ContentID collided for different bytes")
	}
}

// --- helpers ---

func jobIDFor(msgID string) string {
	// Mirror runingest's deterministic (UUIDv5) job-id derivation.
	return uuid.NewSHA1(jobNamespace, []byte(msgID)).String()
}

func lastType(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	return ss[len(ss)-1]
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
