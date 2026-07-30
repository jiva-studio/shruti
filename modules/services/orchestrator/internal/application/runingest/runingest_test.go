package runingest

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
	"github.com/jiva-studio/lectorium/orchestrator/internal/ports"
)

// --- fakes (the hexagonal design makes these cheap) ---

type fakeRepo struct {
	mu   sync.Mutex
	jobs map[string]job.Job
}

func newRepo() *fakeRepo { return &fakeRepo{jobs: map[string]job.Job{}} }

func (r *fakeRepo) CreateTx(_ context.Context, _ ports.Tx, j *job.Job) error { return r.put(j) }
func (r *fakeRepo) SaveTx(_ context.Context, _ ports.Tx, j *job.Job) error   { return r.put(j) }

func (r *fakeRepo) GetForUpdateTx(_ context.Context, _ ports.Tx, id string) (*job.Job, error) {
	return r.Get(context.Background(), id)
}

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

func (r *fakeRepo) WithTx(_ context.Context, fn func(ports.Tx) error) error { return fn(nil) }

// fakeEvents records every outbox publish keyed by topic, so track.events and
// ingest.work dispatches can be asserted separately.
type fakeEvents struct {
	mu   sync.Mutex
	list []published
}

type published struct {
	topic   string
	payload []byte
	delay   time.Duration
}

func (e *fakeEvents) PublishAfter(_ context.Context, _ ports.Tx, topic string, payload []byte, delay time.Duration) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	cp := append([]byte(nil), payload...)
	e.list = append(e.list, published{topic: topic, payload: cp, delay: delay})
	return nil
}

func (e *fakeEvents) Publish(_ context.Context, _ ports.Tx, topic string, payload []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	cp := append([]byte(nil), payload...)
	e.list = append(e.list, published{topic: topic, payload: cp})
	return nil
}

func (e *fakeEvents) trackEvents() []ingest.TrackEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []ingest.TrackEvent
	for _, p := range e.list {
		if p.topic != "track.events" {
			continue
		}
		var ev ingest.TrackEvent
		if err := json.Unmarshal(p.payload, &ev); err == nil {
			out = append(out, ev)
		}
	}
	return out
}

func (e *fakeEvents) works() []ingest.WorkCommand {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []ingest.WorkCommand
	for _, p := range e.list {
		if p.topic != "ingest.work" {
			continue
		}
		var w ingest.WorkCommand
		if err := json.Unmarshal(p.payload, &w); err == nil {
			out = append(out, w)
		}
	}
	return out
}

// workDelays returns the not-before delay each ingest.work row was published
// with, in dispatch order — so a retry's backoff can be asserted.
func (e *fakeEvents) workDelays() []time.Duration {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []time.Duration
	for _, p := range e.list {
		if p.topic == "ingest.work" {
			out = append(out, p.delay)
		}
	}
	return out
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
	tier   fakeTier
	req    *RequestHandler
	res    *ResultHandler
}

func newHarness(maxAttempts int, tier fakeTier) *harness {
	h := &harness{repo: newRepo(), events: &fakeEvents{}, tier: tier}
	d := Deps{
		Repo:              h.repo,
		Events:            h.events,
		Tier:              h.tier,
		MaxAttempts:       maxAttempts,
		TrackEventsStream: "track.events",
		WorkStream:        "ingest.work",
	}
	h.req = NewRequestHandler(d)
	h.res = NewResultHandler(d)
	return h
}

func reqPayload(t *testing.T, url string) []byte {
	t.Helper()
	b, err := json.Marshal(ingest.Request{URL: url, Token: "tok", Title: "A talk", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func resPayload(t *testing.T, r ingest.Result) []byte {
	t.Helper()
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}


func lastTrackType(evs []ingest.TrackEvent) string {
	if len(evs) == 0 {
		return ""
	}
	return evs[len(evs)-1].Type
}

// --- RequestHandler tests ---

func TestRequest_CreatesJobAndDispatchesWork(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	if err := h.req.Process(context.Background(), "msg-1", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process: %v", err)
	}
	jobID := jobIDFor("user-1", "msg-1", "https://x/y")
	j, _ := h.repo.Get(context.Background(), jobID)
	if j == nil || j.State != job.StateQueued {
		t.Fatalf("job not queued: %+v", j)
	}
	// track.queued emitted with a job-derived id.
	evs := h.events.trackEvents()
	if len(evs) != 1 || evs[0].Type != ingest.EventQueued || evs[0].ID != jobID+":queued" {
		t.Fatalf("queued event wrong: %+v", evs)
	}
	// exactly one ingest.work dispatched, attempt 1.
	works := h.events.works()
	if len(works) != 1 {
		t.Fatalf("want 1 ingest.work, got %d", len(works))
	}
	w := works[0]
	if w.JobID != jobID || w.URL != "https://x/y" || w.Title != "A talk" || w.OwnerID != "user-1" || w.Attempt != 1 {
		t.Fatalf("work command wrong: %+v", w)
	}
}

func TestRequest_NotPro_FailsWithoutDispatch(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: false})
	if err := h.req.Process(context.Background(), "msg-2", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("Process should ack (nil), got %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobIDFor("user-1", "msg-2", "https://x/y"))
	if j == nil || j.State != job.StateFailed {
		t.Fatalf("job not failed: %+v", j)
	}
	if got := lastTrackType(h.events.trackEvents()); got != ingest.EventFailed {
		t.Fatalf("last track event = %q, want track.failed", got)
	}
	if n := len(h.events.works()); n != 0 {
		t.Fatalf("no ingest.work should be dispatched for non-pro, got %d", n)
	}
}

func TestRequest_ExistingUnsettled_NoRedispatch(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	// First request dispatches once.
	if err := h.req.Process(context.Background(), "msg-3", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("first: %v", err)
	}
	// Redelivery of the SAME request (same msg id → same job) must not re-dispatch.
	if err := h.req.Process(context.Background(), "msg-3", reqPayload(t, "https://x/y")); err != nil {
		t.Fatalf("redelivery: %v", err)
	}
	if n := len(h.events.works()); n != 1 {
		t.Fatalf("redelivery must not re-dispatch: got %d ingest.work", n)
	}
}

func TestRequest_SameUrlReAdded_Deduped(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	// A later add of the same lecture (DIFFERENT broker message, same user+url)
	// maps to the same job and must not re-dispatch or create a second job.
	if err := h.req.Process(context.Background(), "msg-a", reqPayload(t, "https://youtu.be/2QezV4DhHVo")); err != nil {
		t.Fatalf("first add: %v", err)
	}
	if err := h.req.Process(context.Background(), "msg-b", reqPayload(t, "https://www.youtube.com/watch?v=2QezV4DhHVo&t=30")); err != nil {
		t.Fatalf("re-add: %v", err)
	}
	if n := len(h.events.works()); n != 1 {
		t.Fatalf("re-add of the same lecture must not re-dispatch: got %d ingest.work", n)
	}
}

// --- ResultHandler tests ---

// seed creates a queued job the way the RequestHandler would.
func (h *harness) seedQueued(t *testing.T, msgID, url string) string {
	t.Helper()
	if err := h.req.Process(context.Background(), msgID, reqPayload(t, url)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return jobIDFor("user-1", msgID, url)
}

func TestResult_Processing_MovesToRunning(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-p", "https://x/y")

	if err := h.res.Process(context.Background(), "any", resPayload(t, ingest.Result{JobID: jobID, Phase: ingest.PhaseProcessing})); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State != job.StateRunning {
		t.Fatalf("job not running: %s", j.State)
	}
	if got := lastTrackType(h.events.trackEvents()); got != ingest.EventProcessing {
		t.Fatalf("last track event = %q, want track.processing", got)
	}
}

func TestResult_Ready_MarksDone(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-r", "https://x/y")
	_ = h.res.Process(context.Background(), "any", resPayload(t, ingest.Result{JobID: jobID, Phase: ingest.PhaseProcessing}))

	ready := ingest.Result{
		JobID: jobID, Phase: ingest.PhaseReady, TrackID: "hash123", Lang: "en",
		Title: "A talk", AudioKey: "public/tracks/hash123/audio",
		TranscriptKey: "public/tracks/hash123/transcript", SourceURL: "https://x/y",
	}
	if err := h.res.Process(context.Background(), "any", resPayload(t, ready)); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State != job.StateDone || j.TrackID != "hash123" {
		t.Fatalf("job not done onto track: %+v", j)
	}
	last := h.events.trackEvents()
	le := last[len(last)-1]
	if le.Type != ingest.EventReady || le.ID != jobID+":ready" || le.TrackID != "hash123" {
		t.Fatalf("ready event wrong: %+v", le)
	}
	// The ready event keys the projection on the membership id (jobID), the SAME
	// doc_id as the earlier queued/processing events — NOT the content hash — so
	// the library_items row advances in place instead of orphaning.
	if le.DocID != jobID {
		t.Fatalf("ready doc_id must be the membership jobID %q, got %q", jobID, le.DocID)
	}
	for _, ev := range last {
		if ev.DocID != jobID {
			t.Fatalf("lifecycle event %s keyed on %q, want membership jobID %q", ev.Type, ev.DocID, jobID)
		}
	}
}

func TestResult_ReadyWhileQueued_MarksDone(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-l", "https://x/y")
	// A ready result can arrive while the job is still queued (the worker's
	// processing heartbeat may not have landed) — it must step through running
	// and still settle to done.
	ready := ingest.Result{JobID: jobID, Phase: ingest.PhaseReady, TrackID: "dedup1", Lang: "en", Title: "A talk"}
	if err := h.res.Process(context.Background(), "any", resPayload(t, ready)); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State != job.StateDone || j.TrackID != "dedup1" {
		t.Fatalf("ready job not done: %+v", j)
	}
	if got := lastTrackType(h.events.trackEvents()); got != ingest.EventReady {
		t.Fatalf("last track event = %q, want track.ready", got)
	}
}

func TestResult_RetriableFailed_Redispatches(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-f", "https://x/y") // 1 ingest.work so far

	// The failed result echoes the in-flight attempt (1 — the initial dispatch).
	failed := ingest.Result{JobID: jobID, Attempt: 1, Phase: ingest.PhaseFailed, Error: "boom", Retriable: true}
	if err := h.res.Process(context.Background(), "any", resPayload(t, failed)); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State.IsTerminal() {
		t.Fatalf("retriable failure must not be terminal: %s", j.State)
	}
	if j.Attempts != 1 {
		t.Fatalf("attempts = %d, want 1", j.Attempts)
	}
	works := h.events.works()
	if len(works) != 2 {
		t.Fatalf("retry must re-dispatch: got %d ingest.work", len(works))
	}
	if works[1].Attempt != 2 || works[1].URL != "https://x/y" {
		t.Fatalf("re-dispatch command wrong: %+v", works[1])
	}
	// The initial dispatch is immediate; the retry carries a backoff so a
	// transient outage isn't burned through in milliseconds.
	delays := h.events.workDelays()
	if delays[0] != 0 {
		t.Fatalf("initial dispatch must be immediate, got delay %s", delays[0])
	}
	if delays[1] != retryBackoff(2) || delays[1] <= 0 {
		t.Fatalf("retry delay = %s, want backoff %s", delays[1], retryBackoff(2))
	}
}

func TestRetryBackoff(t *testing.T) {
	if d := retryBackoff(1); d != 0 {
		t.Fatalf("first attempt must be immediate, got %s", d)
	}
	// Monotonic, exponential, capped at 2m.
	cases := map[int]time.Duration{
		2: 15 * time.Second,
		3: 30 * time.Second,
		4: 60 * time.Second,
		5: 2 * time.Minute, // 120s == cap
		6: 2 * time.Minute, // capped
		9: 2 * time.Minute, // capped, no int64 overflow on the shift
	}
	for attempt, want := range cases {
		if got := retryBackoff(attempt); got != want {
			t.Errorf("retryBackoff(%d) = %s, want %s", attempt, got, want)
		}
	}
}

// A redelivered failed result whose attempt was already superseded by a
// re-dispatch must be ignored — no duplicate ingest.work, no double attempt count.
func TestResult_StaleRetriableFailed_Ignored(t *testing.T) {
	h := newHarness(5, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-stale", "https://x/y") // 1 ingest.work, attempt 1

	// First failure for attempt 1 → re-dispatches attempt 2, Attempts→1.
	if err := h.res.Process(context.Background(), "a", resPayload(t, ingest.Result{JobID: jobID, Attempt: 1, Phase: ingest.PhaseFailed, Error: "boom", Retriable: true})); err != nil {
		t.Fatalf("first failed: %v", err)
	}
	// Redelivery of that SAME attempt-1 failure (already superseded) → ignored.
	if err := h.res.Process(context.Background(), "a-again", resPayload(t, ingest.Result{JobID: jobID, Attempt: 1, Phase: ingest.PhaseFailed, Error: "boom", Retriable: true})); err != nil {
		t.Fatalf("redelivered failed: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.Attempts != 1 {
		t.Fatalf("stale redelivery double-counted attempts: %d, want 1", j.Attempts)
	}
	if n := len(h.events.works()); n != 2 {
		t.Fatalf("stale redelivery re-dispatched: got %d ingest.work, want 2", n)
	}
}

func TestResult_RetriableFailed_DeadLettersAtCap(t *testing.T) {
	h := newHarness(1, fakeTier{userID: "user-1", pro: true}) // cap = 1
	jobID := h.seedQueued(t, "msg-d", "https://x/y")
	// First retriable failure (attempt 1): Attempts 0 < 1 → re-dispatch, Attempts→1.
	_ = h.res.Process(context.Background(), "a", resPayload(t, ingest.Result{JobID: jobID, Attempt: 1, Phase: ingest.PhaseFailed, Error: "boom", Retriable: true}))
	// Second retriable failure (attempt 2, the re-dispatch): Attempts 1 >= cap → dead-letter.
	if err := h.res.Process(context.Background(), "b", resPayload(t, ingest.Result{JobID: jobID, Attempt: 2, Phase: ingest.PhaseFailed, Error: "boom2", Retriable: true})); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State != job.StateFailed {
		t.Fatalf("job not failed at cap: %s", j.State)
	}
	if got := lastTrackType(h.events.trackEvents()); got != ingest.EventFailed {
		t.Fatalf("last track event = %q, want track.failed", got)
	}
}

func TestResult_PermanentFailed_DeadLetters(t *testing.T) {
	h := newHarness(5, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-perm", "https://x/y")

	failed := ingest.Result{JobID: jobID, Attempt: 1, Phase: ingest.PhaseFailed, Error: "unsupported", Retriable: false}
	if err := h.res.Process(context.Background(), "any", resPayload(t, failed)); err != nil {
		t.Fatalf("Process: %v", err)
	}
	j, _ := h.repo.Get(context.Background(), jobID)
	if j.State != job.StateFailed || j.Err != "unsupported" {
		t.Fatalf("permanent failure not dead-lettered: %+v", j)
	}
	if n := len(h.events.works()); n != 1 {
		t.Fatalf("permanent failure must not re-dispatch: got %d ingest.work", n)
	}
}

func TestResult_UnknownJob_Ignored(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	if err := h.res.Process(context.Background(), "any", resPayload(t, ingest.Result{JobID: "nope", Phase: ingest.PhaseReady})); err != nil {
		t.Fatalf("unknown job should ack (nil), got %v", err)
	}
}

func TestResult_SettledJob_Idempotent(t *testing.T) {
	h := newHarness(3, fakeTier{userID: "user-1", pro: true})
	jobID := h.seedQueued(t, "msg-s", "https://x/y")
	_ = h.res.Process(context.Background(), "a", resPayload(t, ingest.Result{JobID: jobID, Phase: ingest.PhaseReady, TrackID: "h"}))
	before := len(h.events.trackEvents())
	// Redelivery of a result for a settled (done) job is a no-op.
	if err := h.res.Process(context.Background(), "b", resPayload(t, ingest.Result{JobID: jobID, Phase: ingest.PhaseReady, TrackID: "h"})); err != nil {
		t.Fatalf("Process: %v", err)
	}
	if after := len(h.events.trackEvents()); after != before {
		t.Fatalf("settled job re-emitted events: before=%d after=%d", before, after)
	}
}
