package worker

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/transcript"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcriber"
)

type fakeTranscriber struct {
	name      string
	delay     time.Duration
	inflight  atomic.Int64
	maxSeen   atomic.Int64
}

func (f *fakeTranscriber) Name() string { return f.name }

func (f *fakeTranscriber) Transcribe(ctx context.Context, audioPath string, opts transcriber.Options) (transcript.Raw, error) {
	cur := f.inflight.Add(1)
	for {
		seen := f.maxSeen.Load()
		if cur <= seen || f.maxSeen.CompareAndSwap(seen, cur) {
			break
		}
	}
	defer f.inflight.Add(-1)
	select {
	case <-time.After(f.delay):
		return transcript.Raw{}, nil
	case <-ctx.Done():
		return transcript.Raw{}, ctx.Err()
	}
}

// TestThrottledTranscriberCap shows that with N=5 callers and sem=2, at no
// point are more than 2 concurrently inside the inner Transcribe.
func TestThrottledTranscriberCap(t *testing.T) {
	inner := &fakeTranscriber{name: "fake", delay: 50 * time.Millisecond}
	tr := NewThrottledTranscriber(inner, 2)

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = tr.Transcribe(context.Background(), "/tmp/x.mp3", transcriber.Options{})
		}()
	}
	wg.Wait()

	if got := inner.maxSeen.Load(); got > 2 {
		t.Fatalf("max concurrent inside inner = %d, want ≤2", got)
	}
}

// TestThrottledTranscriberZeroCap: cap≤0 should pass-through (no throttling).
func TestThrottledTranscriberZeroCap(t *testing.T) {
	inner := &fakeTranscriber{name: "fake", delay: 10 * time.Millisecond}
	tr := NewThrottledTranscriber(inner, 0)
	if tr != inner {
		t.Fatalf("cap=0 should return inner unwrapped, got %T", tr)
	}
}
