package worker

import (
	"context"

	"golang.org/x/sync/semaphore"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/transcript"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/transcriber"
)

// throttledTranscriber wraps a transcriber.Transcriber so the daemon can hold
// at most N concurrent calls in flight. Used in the composition root to honor
// hard external caps (M-box transcriber-service handles 2 jobs at a time —
// without this, a 4-worker pool would over-subscribe and waste retries).
type throttledTranscriber struct {
	inner transcriber.Transcriber
	sem   *semaphore.Weighted
}

// NewThrottledTranscriber wraps inner with a semaphore allowing at most
// `cap` concurrent Transcribe calls across the whole process. cap<=0 returns
// inner unwrapped.
func NewThrottledTranscriber(inner transcriber.Transcriber, cap int) transcriber.Transcriber {
	if cap <= 0 {
		return inner
	}
	return throttledTranscriber{
		inner: inner,
		sem:   semaphore.NewWeighted(int64(cap)),
	}
}

func (t throttledTranscriber) Name() string { return t.inner.Name() }

func (t throttledTranscriber) Transcribe(ctx context.Context, audioPath string, opts transcriber.Options) (transcript.Raw, error) {
	if err := t.sem.Acquire(ctx, 1); err != nil {
		return transcript.Raw{}, err
	}
	defer t.sem.Release(1)
	return t.inner.Transcribe(ctx, audioPath, opts)
}
