package throttledreview

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/pipeline/ports/review"
)

// fakeSlowReviewer counts in-flight ReviewChunk calls; while a call is
// in flight, sleeps for `latency` so we can measure peak concurrency
// from the outside.
type fakeSlowReviewer struct {
	latency  time.Duration
	inflight int32
	peak     int32
}

func (f *fakeSlowReviewer) Name() string { return "fake" }

func (f *fakeSlowReviewer) ReviewChunk(ctx context.Context, _ review.ChunkRequest) (review.ChunkResponse, error) {
	cur := atomic.AddInt32(&f.inflight, 1)
	defer atomic.AddInt32(&f.inflight, -1)
	for {
		old := atomic.LoadInt32(&f.peak)
		if cur <= old || atomic.CompareAndSwapInt32(&f.peak, old, cur) {
			break
		}
	}
	select {
	case <-time.After(f.latency):
	case <-ctx.Done():
		return review.ChunkResponse{}, ctx.Err()
	}
	return review.ChunkResponse{Models: []review.ModelEntry{{Role: "single", Name: "fake"}}}, nil
}

func TestThrottle_CapsConcurrency(t *testing.T) {
	const maxConcurrent = 3
	const callers = 20

	inner := &fakeSlowReviewer{latency: 50 * time.Millisecond}
	r := New(inner, maxConcurrent)

	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := r.ReviewChunk(t.Context(), review.ChunkRequest{Language: "ru"})
			if err != nil {
				t.Errorf("unexpected err: %v", err)
			}
		}()
	}
	wg.Wait()

	peak := atomic.LoadInt32(&inner.peak)
	if peak > maxConcurrent {
		t.Errorf("peak inflight = %d, expected ≤ %d", peak, maxConcurrent)
	}
	if peak == 0 {
		t.Error("peak should record at least 1 inflight call")
	}
}

func TestThrottle_PassthroughWhenZero(t *testing.T) {
	inner := &fakeSlowReviewer{latency: 1 * time.Millisecond}
	r := New(inner, 0)
	if r.sem != nil {
		t.Error("zero cap should disable semaphore (sem=nil)")
	}
	if _, err := r.ReviewChunk(t.Context(), review.ChunkRequest{Language: "ru"}); err != nil {
		t.Errorf("passthrough should not error: %v", err)
	}
}

func TestThrottle_RespectsContextCancel(t *testing.T) {
	inner := &fakeSlowReviewer{latency: 1 * time.Second}
	r := New(inner, 1)

	// fill the slot with a call that won't finish during the test
	go func() {
		_, _ = r.ReviewChunk(t.Context(), review.ChunkRequest{Language: "ru"})
	}()
	time.Sleep(10 * time.Millisecond) // let the goroutine grab the slot

	// caller with a cancelled context should NOT block waiting for the slot
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := r.ReviewChunk(ctx, review.ChunkRequest{Language: "ru"})
	if err == nil {
		t.Error("expected ctx.Err() when context already cancelled")
	}
}

func TestThrottle_ForwardsName(t *testing.T) {
	r := New(&fakeSlowReviewer{}, 5)
	if got := r.Name(); got != "fake" {
		t.Errorf("Name() = %q, want %q", got, "fake")
	}
}
