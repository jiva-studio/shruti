package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/jiva-studio/lectorium/ingest/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/ingest/internal/infra/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// --- fakes ---

// fakeFetcher writes `content` to a fresh temp dir and returns its path + the
// real content hash, so runingest's os.ReadFile / content-addressing is
// exercised end-to-end.
type fakeFetcher struct {
	content  []byte
	err      error
	calls    int
	progress []int // percents reported through onProgress
}

func (f *fakeFetcher) Fetch(_ context.Context, _ string, onProgress func(int)) (string, string, error) {
	f.calls++
	if onProgress != nil {
		for _, p := range []int{5, 40, 100} {
			onProgress(p)
		}
	}
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
	empty bool // when true, return a 200-but-empty transcript (no segments)
	calls int
}

func (t *fakeTranscriber) Transcribe(_ context.Context, _ string) (transcript.Raw, string, error) {
	t.calls++
	if t.err != nil {
		return transcript.Raw{}, "", t.err
	}
	if t.empty {
		return transcript.Raw{Language: t.lang}, t.lang, nil
	}
	raw := transcript.Raw{
		Language: t.lang,
		Segments: []transcript.RawSegment{{Idx: 0, Start: 0, End: 1000, Text: "hello"}},
	}
	return raw, t.lang, nil
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

type fakeResults struct {
	mu           sync.Mutex
	list         []ingest.Result
	failTerminal bool // when true, publishing a ready/failed result errors
}

func (r *fakeResults) Publish(_ context.Context, res ingest.Result) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.list = append(r.list, res)
	if r.failTerminal && res.Phase != ingest.PhaseProcessing {
		return errors.New("broker unavailable")
	}
	return nil
}

func (r *fakeResults) phases() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.list))
	for i, res := range r.list {
		out[i] = res.Phase
	}
	return out
}

// stages returns the Stage of every non-empty-stage result, in order — the
// granular pipeline heartbeats.
func (r *fakeResults) stages() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, res := range r.list {
		if res.Stage != "" {
			out = append(out, res.Stage)
		}
	}
	return out
}

// downloadPercents returns the Percent of every download heartbeat that carried
// one, in order — the throttled progress ticks.
func (r *fakeResults) downloadPercents() []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []int
	for _, res := range r.list {
		if res.Stage == ingest.StageDownloading && res.Percent > 0 {
			out = append(out, res.Percent)
		}
	}
	return out
}

func (r *fakeResults) last() ingest.Result {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.list) == 0 {
		return ingest.Result{}
	}
	return r.list[len(r.list)-1]
}

// --- harness ---

type harness struct {
	fetch   *fakeFetcher
	trans   *fakeTranscriber
	blob    *fakeBlob
	results *fakeResults
	svc     *Service
}

func newHarness() *harness {
	h := &harness{
		fetch:   &fakeFetcher{content: []byte("audio-bytes")},
		trans:   &fakeTranscriber{lang: "en"},
		blob:    newBlob(),
		results: &fakeResults{},
	}
	h.svc = New(Deps{
		Fetcher:     h.fetch,
		Transcriber: h.trans,
		Reviewer:    review.New(),
		Blob:        h.blob,
		Results:     h.results,
	})
	return h
}

func workPayload(t *testing.T, url string) []byte {
	t.Helper()
	b, err := json.Marshal(ingest.WorkCommand{JobID: "job-1", URL: url, Title: "A talk", OwnerID: "user-1", Attempt: 1})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// --- tests ---

func TestProcess_Ready(t *testing.T) {
	h := newHarness()
	if err := h.svc.Process(context.Background(), "msg-1", workPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process: %v", err)
	}

	hash := ingest.ContentID([]byte("audio-bytes"))
	audioKey := "public/tracks/" + hash + "/audio/original.mp3"
	transcriptKey := "public/tracks/" + hash + "/transcripts/en.json"
	if _, ok := h.blob.objects[audioKey]; !ok {
		t.Fatal("audio not stored at MCP key")
	}
	body, ok := h.blob.objects[transcriptKey]
	if !ok {
		t.Fatal("transcript not stored at MCP key")
	}
	// The stored transcript must be the reviewed artifact (transcript.Reviewed),
	// not the raw ASR — verify it round-trips and carries the windowed block.
	var rev transcript.Reviewed
	if err := json.Unmarshal(body, &rev); err != nil {
		t.Fatalf("stored transcript is not transcript.Reviewed json: %v", err)
	}
	if rev.TrackId != hash || rev.Language != "en" || rev.Version != 1 || len(rev.Blocks) != 1 {
		t.Fatalf("reviewed transcript wrong: %+v", rev)
	}
	// A processing heartbeat per pipeline stage precedes the terminal ready, plus
	// the throttled download-percent heartbeats (fetcher reports 5/40/100 → the
	// 5%-step filter emits all three on top of the initial downloading tick).
	if got, want := h.results.phases(), []string{
		ingest.PhaseProcessing, ingest.PhaseProcessing, ingest.PhaseProcessing,
		ingest.PhaseProcessing, ingest.PhaseProcessing, ingest.PhaseProcessing,
		ingest.PhaseProcessing, ingest.PhaseReady,
	}; !equal(got, want) {
		t.Fatalf("phases = %v, want %v", got, want)
	}
	// The heartbeats carry the stage labels, in pipeline order (downloading
	// repeats for its percent updates).
	if got, want := h.results.stages(), []string{
		ingest.StageDownloading, ingest.StageDownloading, ingest.StageDownloading,
		ingest.StageDownloading,
		ingest.StageTranscribing, ingest.StageReviewing, ingest.StageStoring,
	}; !equal(got, want) {
		t.Fatalf("stages = %v, want %v", got, want)
	}
	// The download heartbeats carry the completion percent (5%-step filter passes
	// all of the fetcher's 5/40/100).
	if got, want := h.results.downloadPercents(), []int{5, 40, 100}; !equalInts(got, want) {
		t.Fatalf("download percents = %v, want %v", got, want)
	}
	last := h.results.last()
	if last.JobID != "job-1" || last.TrackID != hash || last.Lang != "en" {
		t.Fatalf("ready result wrong: %+v", last)
	}
	if last.AudioKey != audioKey || last.TranscriptKey != transcriptKey {
		t.Fatalf("ready result keys wrong: %+v", last)
	}
}

// A 200-but-empty transcription must NOT be announced as ready with an empty
// transcript — it fails retriably so the attempt is retried (and dead-letters
// as failed at the cap) rather than storing a useless ready track.
func TestProcess_EmptyTranscript_FailedRetriable(t *testing.T) {
	h := newHarness()
	h.trans.empty = true

	if err := h.svc.Process(context.Background(), "msg-empty", workPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process must ack (nil), got %v", err)
	}
	last := h.results.last()
	if last.Phase != ingest.PhaseFailed || !last.Retriable {
		t.Fatalf("expected retriable failed on empty transcript, got %+v", last)
	}
	// Nothing must have been announced ready, and no transcript blob stored.
	for _, ph := range h.results.phases() {
		if ph == ingest.PhaseReady {
			t.Fatal("empty transcript must not reach ready")
		}
	}
	hash := ingest.ContentID([]byte("audio-bytes"))
	if _, ok := h.blob.objects["public/tracks/"+hash+"/transcripts/en.json"]; ok {
		t.Fatal("empty transcript must not be stored")
	}
}

func TestProcess_Failed_Transient(t *testing.T) {
	h := newHarness()
	h.fetch = &fakeFetcher{err: errors.New("connection reset")}
	h.svc = New(Deps{Fetcher: h.fetch, Transcriber: h.trans, Reviewer: review.New(), Blob: h.blob, Results: h.results})

	if err := h.svc.Process(context.Background(), "msg-3", workPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process must ack (nil), got %v", err)
	}
	last := h.results.last()
	if last.Phase != ingest.PhaseFailed || !last.Retriable {
		t.Fatalf("expected retriable failed, got %+v", last)
	}
}

func TestProcess_Failed_Permanent(t *testing.T) {
	h := newHarness()
	h.fetch = &fakeFetcher{err: fmt.Errorf("fetch: invalid url %q: %w", "::bad::", ingest.ErrPermanent)}
	h.svc = New(Deps{Fetcher: h.fetch, Transcriber: h.trans, Reviewer: review.New(), Blob: h.blob, Results: h.results})

	if err := h.svc.Process(context.Background(), "msg-4", workPayload(t, "::bad::")); err != nil {
		t.Fatalf("Process must ack (nil), got %v", err)
	}
	last := h.results.last()
	if last.Phase != ingest.PhaseFailed || last.Retriable {
		t.Fatalf("expected permanent (non-retriable) failed, got %+v", last)
	}
}

func TestProcess_HeadVerifyFailure_Failed(t *testing.T) {
	h := newHarness()
	h.blob.existsNo = true // artifacts "vanish" — HEAD-verify fails after put

	if err := h.svc.Process(context.Background(), "msg-5", workPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process must ack (nil), got %v", err)
	}
	if last := h.results.last(); last.Phase != ingest.PhaseFailed {
		t.Fatalf("expected failed on HEAD-verify miss, got %+v", last)
	}
}

// A terminal result whose publish fails must NOT be acked: Process returns the
// error so the entry stays pending and redelivery re-runs the pipeline.
func TestProcess_TerminalPublishFails_NotAcked(t *testing.T) {
	h := newHarness()
	h.results.failTerminal = true
	err := h.svc.Process(context.Background(), "msg-term", workPayload(t, "https://x/y"))
	if err == nil {
		t.Fatal("expected Process to return an error (leave pending) when the terminal result publish fails")
	}
	if last := h.results.last(); last.Phase != ingest.PhaseReady {
		t.Fatalf("expected a ready terminal attempt, got %+v", last)
	}
}

func TestProcess_PoisonPill_Dropped(t *testing.T) {
	h := newHarness()
	if err := h.svc.Process(context.Background(), "msg-6", []byte("{not json")); err != nil {
		t.Fatalf("poison pill should ack (nil), got %v", err)
	}
	if len(h.results.phases()) != 0 {
		t.Fatalf("poison pill should emit no results, got %v", h.results.phases())
	}
}

// --- helpers ---

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

func equalInts(a, b []int) bool {
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

// fakeTranslator prefixes each line with a [lang] tag so a test can assert the
// translated variant was produced and stored under the right language.
type fakeTranslator struct{}

func (fakeTranslator) Translate(_ context.Context, text, _, to string) (string, error) {
	if text == "" {
		return "", nil
	}
	return "[" + to + "] " + text, nil
}

func (fakeTranslator) TranslateBatch(_ context.Context, texts []string, _, to string) ([]string, error) {
	out := make([]string, len(texts))
	for i, t := range texts {
		if t != "" {
			out[i] = "[" + to + "] " + t
		}
	}
	return out, nil
}

// A requested language that was NOT spoken gets a full translated variant:
// transcript stored under its key, blocks translated, title translated. A run
// without the request (default) produces no such variant.
func TestProcess_TranslatedVariantOnRequest(t *testing.T) {
	h := &harness{
		fetch:   &fakeFetcher{content: []byte("audio-bytes")},
		trans:   &fakeTranscriber{lang: "en"},
		blob:    newBlob(),
		results: &fakeResults{},
	}
	h.svc = New(Deps{
		Fetcher:     h.fetch,
		Transcriber: h.trans,
		Reviewer:    review.New(),
		Blob:        h.blob,
		Results:     h.results,
		Translator:  fakeTranslator{},
	})
	payload, err := json.Marshal(ingest.WorkCommand{
		JobID: "job-1", URL: "https://x/y", Title: "A talk", OwnerID: "user-1",
		Attempt: 1, TranslateLangs: []string{"ru"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Process(context.Background(), "m", payload); err != nil {
		t.Fatalf("Process: %v", err)
	}

	hash := ingest.ContentID([]byte("audio-bytes"))
	body, ok := h.blob.objects["public/tracks/"+hash+"/transcripts/ru.json"]
	if !ok {
		t.Fatal("translated ru transcript not stored")
	}
	var rev transcript.Reviewed
	if err := json.Unmarshal(body, &rev); err != nil {
		t.Fatalf("stored translated transcript not json: %v", err)
	}
	if rev.Language != "ru" {
		t.Fatalf("translated transcript language = %q, want ru", rev.Language)
	}

	var ru *ingest.Variant
	for i := range h.results.last().Variants {
		if h.results.last().Variants[i].Lang == "ru" {
			ru = &h.results.last().Variants[i]
		}
	}
	if ru == nil {
		t.Fatal("no ru variant in the ready result")
	}
	if ru.Title != "[ru] A talk" {
		t.Fatalf("ru variant title = %q, want translated", ru.Title)
	}
}

// Without a translate request, no extra variant is produced even if a translator
// is configured — full translation is opt-in.
func TestProcess_NoTranslationWithoutRequest(t *testing.T) {
	h := &harness{
		fetch:   &fakeFetcher{content: []byte("audio-bytes")},
		trans:   &fakeTranscriber{lang: "en"},
		blob:    newBlob(),
		results: &fakeResults{},
	}
	h.svc = New(Deps{
		Fetcher:     h.fetch,
		Transcriber: h.trans,
		Reviewer:    review.New(),
		Blob:        h.blob,
		Results:     h.results,
		Translator:  fakeTranslator{},
	})
	if err := h.svc.Process(context.Background(), "m", workPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process: %v", err)
	}
	hash := ingest.ContentID([]byte("audio-bytes"))
	if _, ok := h.blob.objects["public/tracks/"+hash+"/transcripts/ru.json"]; ok {
		t.Fatal("a translated variant was produced without a request")
	}
}
