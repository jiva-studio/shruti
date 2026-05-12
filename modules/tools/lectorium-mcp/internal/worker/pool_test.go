package worker

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runpipeline"
)

// fakeRunpipelineRunner is the seam between the pool and the real
// runpipeline.UseCase. The pool only calls .Run, so we use a func field
// to avoid building the entire UseCase (which needs SQLite, ffmpeg, …)
// just to test pool behaviour.
//
// runpipeline.UseCase isn't an interface, so the test substitutes a stand-in
// that satisfies the same shape via a small adapter declared in pool.go's
// production code. To keep the diff minimal, the test instead asserts pool
// timing by routing through a fakeRun() that's wired through a custom Run.
//
// Implementation note: pool.go calls `p.uc.Run(ctx, item.Path, item.Opts)`.
// We construct a real (zero-valued) runpipeline.UseCase whose internal
// methods we don't exercise — pool.go only ever invokes Run, so we can
// stub it via a wrapper test type. The cleanest path is a small
// runner-interface refactor, but the bare minimum here uses time.Sleep'd
// fake execution by exposing a hook.

// stubPool wraps a Pool and intercepts the run path with a fake handler.
// Lets us write timing tests without the full pipeline plumbing.
type stubPool struct {
	*Pool
	handler func(ctx context.Context, path string)
	calls   atomic.Int64
}

func newStubPool(workers int, handler func(context.Context, string)) *stubPool {
	p := New(runpipeline.UseCase{}, workers, 0)
	return &stubPool{Pool: p, handler: handler}
}

// startWithStub spawns the same number of worker goroutines as Pool.Start
// but routes work through s.handler instead of the real runpipeline.Run.
func (s *stubPool) startWithStub(ctx context.Context) {
	for i := 0; i < s.workers; i++ {
		go func(id int) {
			for {
				select {
				case <-ctx.Done():
					return
				case item, ok := <-s.queue:
					if !ok {
						return
					}
					s.markRunning(id, item.Path)
					s.handler(ctx, item.Path)
					s.calls.Add(1)
					s.markIdle(id)
				}
			}
		}(i)
	}
}

// TestPoolParallelism: with 4 workers and 8 items at 100ms each, the wall
// time should be ~200ms (two batches), not ~800ms (sequential).
func TestPoolParallelism(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const workers = 4
	const items = 8
	const itemDelay = 100 * time.Millisecond

	sp := newStubPool(workers, func(_ context.Context, _ string) {
		time.Sleep(itemDelay)
	})
	sp.startWithStub(ctx)

	start := time.Now()
	for i := 0; i < items; i++ {
		if err := sp.Submit(ctx, Item{Path: "/tmp/x.mp3"}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}
	for sp.calls.Load() < items {
		time.Sleep(5 * time.Millisecond)
	}
	elapsed := time.Since(start)

	// 8 items / 4 workers = 2 sequential rounds × 100ms = ~200ms.
	// Allow generous slack for goroutine startup and CI jitter.
	if elapsed > 400*time.Millisecond {
		t.Fatalf("expected ~200ms with %d workers, got %v", workers, elapsed)
	}
	if elapsed < itemDelay {
		t.Fatalf("suspiciously fast (%v) — handler may not have run", elapsed)
	}
}

// TestPoolContextCancel: cancelling the start ctx should stop workers
// promptly and not leak goroutines on Submit's blocked path.
func TestPoolContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	var inflight atomic.Int64
	sp := newStubPool(2, func(_ context.Context, _ string) {
		inflight.Add(1)
		time.Sleep(50 * time.Millisecond)
		inflight.Add(-1)
	})
	sp.startWithStub(ctx)

	// Push two items; both should pick up immediately.
	for i := 0; i < 2; i++ {
		if err := sp.Submit(ctx, Item{Path: "/tmp/x.mp3"}); err != nil {
			t.Fatalf("submit: %v", err)
		}
	}
	time.Sleep(10 * time.Millisecond)
	if inflight.Load() == 0 {
		t.Fatalf("workers didn't pick up items")
	}
	cancel()
	// Workers finish in-flight then exit. Wait briefly.
	deadline := time.Now().Add(500 * time.Millisecond)
	for inflight.Load() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if inflight.Load() != 0 {
		t.Fatalf("inflight > 0 after cancel + wait")
	}
}

// TestPoolStatusSnapshot: while a worker is mid-flight, Status() reports
// it in the running list with the right path and a recent timestamp.
func TestPoolStatusSnapshot(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	gate := make(chan struct{})
	sp := newStubPool(1, func(_ context.Context, _ string) {
		<-gate // hold worker until test releases
	})
	sp.startWithStub(ctx)

	if err := sp.Submit(ctx, Item{Path: "/tmp/heldback.mp3"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// Give worker a moment to pick up.
	time.Sleep(20 * time.Millisecond)

	st := sp.Status()
	if st.Workers != 1 {
		t.Fatalf("Status.Workers = %d, want 1", st.Workers)
	}
	if len(st.Running) != 1 {
		t.Fatalf("Status.Running len = %d, want 1", len(st.Running))
	}
	if st.Running[0].Path != "/tmp/heldback.mp3" {
		t.Fatalf("Status.Running[0].Path = %q", st.Running[0].Path)
	}
	if time.Since(st.Running[0].Since) > time.Second {
		t.Fatalf("Status.Running[0].Since is stale: %v", st.Running[0].Since)
	}
	close(gate) // unblock worker so test can shut down
}

// panickingRunner implements the unexported runner interface. The first
// call for a path in panicOn panics; everything else returns ok. Used
// to verify the pool's recover path.
type panickingRunner struct {
	calls   atomic.Int64
	panicOn map[string]bool
}

func (r *panickingRunner) Run(_ context.Context, path string, _ runpipeline.Options) runpipeline.FileSummary {
	r.calls.Add(1)
	if r.panicOn[path] {
		panic("synthetic panic for " + path)
	}
	return runpipeline.FileSummary{Path: path, Status: "ok"}
}

// TestWorkerPoolSurvivesPanic asserts that a panic inside uc.Run does not
// kill the worker — subsequent items still drain. Without recover() in
// runItem, the goroutine dies on the panicking item and any later submission
// to the same worker (single-worker pool here) blocks forever.
func TestWorkerPoolSurvivesPanic(t *testing.T) {
	r := &panickingRunner{panicOn: map[string]bool{"/bad.mp3": true}}
	p := New(r, 1, 8) // single worker, so we prove the same goroutine survives
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p.Start(ctx)

	for _, path := range []string{"/bad.mp3", "/good1.mp3", "/good2.mp3"} {
		if err := p.Submit(ctx, Item{Path: path}); err != nil {
			t.Fatalf("submit %s: %v", path, err)
		}
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && r.calls.Load() < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := r.calls.Load(); got != 3 {
		t.Fatalf("expected 3 calls (panic must not strand the worker), got %d", got)
	}

	// markIdle must run via defer even on panic — running map empty after drain.
	if rs := p.Status().Running; len(rs) != 0 {
		t.Fatalf("expected idle pool after drain, got %+v", rs)
	}
}
