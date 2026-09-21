package httpx

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestDispatcher(timeout time.Duration) *Dispatcher {
	return NewDispatcher(timeout, slog.New(slog.NewTextHandler(discardWriter{}, nil)))
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func TestDispatcher_RunsOncePerKey(t *testing.T) {
	d := newTestDispatcher(2 * time.Second)
	var ran atomic.Int32
	start := make(chan struct{})
	done := make(chan struct{})

	work := func(ctx context.Context) {
		ran.Add(1)
		<-start
		close(done)
	}

	first := d.Dispatch(t.Context(), "k", work)
	// Second dispatch with the same key while first is still running:
	// must be a no-op.
	second := d.Dispatch(t.Context(), "k", func(ctx context.Context) {
		t.Fatalf("second work for key 'k' should not have run")
	})
	if !first {
		t.Fatalf("first Dispatch should have scheduled work, got false")
	}
	if second {
		t.Fatalf("second Dispatch for in-flight key should be coalesced, got true")
	}
	close(start)
	<-done
	if got := ran.Load(); got != 1 {
		t.Fatalf("expected work to run exactly once, got %d", got)
	}
}

func TestDispatcher_KeyReleasesAfterWork(t *testing.T) {
	d := newTestDispatcher(2 * time.Second)
	var wg sync.WaitGroup
	wg.Add(1)
	first := d.Dispatch(t.Context(), "k", func(ctx context.Context) {
		defer wg.Done()
	})
	if !first {
		t.Fatalf("first Dispatch returned false")
	}
	wg.Wait()
	// After the worker finishes the key should be free. Give the
	// goroutine's deferred cleanup a moment to run before re-dispatching.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if d.Dispatch(t.Context(), "k", func(ctx context.Context) {}) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("expected key 'k' to be released after worker finished, still inflight")
}

func TestDispatcher_WorkerOutlivesTheRequest(t *testing.T) {
	// Sanity-check that the worker doesn't inherit cancellation from a
	// caller-passed ctx — Dispatch doesn't take one, but the worker ctx
	// should have a deadline from the dispatcher's own timeout.
	d := newTestDispatcher(100 * time.Millisecond)
	gotDeadline := make(chan bool, 1)
	d.Dispatch(t.Context(), "k", func(ctx context.Context) {
		_, ok := ctx.Deadline()
		gotDeadline <- ok
	})
	select {
	case ok := <-gotDeadline:
		if !ok {
			t.Fatalf("worker ctx should carry the dispatcher timeout deadline")
		}
	case <-time.After(time.Second):
		t.Fatalf("worker did not run")
	}
}
