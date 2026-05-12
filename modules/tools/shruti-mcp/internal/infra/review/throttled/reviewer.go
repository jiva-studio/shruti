// Package throttledreview wraps any review.Reviewer with a global
// semaphore. The wrapped reviewer is registered under the same Name() as
// its inner, so the rest of the pipeline doesn't notice — but every
// inflight ReviewChunk call must hold a slot, capping the total parallel
// LLM calls regardless of how many worker pool slots × per-track
// review.concurrency we configure.
//
// Without this, a 4-worker pool × review.concurrency=3 can fan out 12
// concurrent Gemini calls; on the free tier (10 RPM) most of them get
// 429'd. Throttle pins the cap to the configured value.
package throttledreview

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/review"
)

type Reviewer struct {
	inner review.Reviewer
	sem   chan struct{}
}

// New returns a Reviewer that limits in-flight ReviewChunk calls to
// maxConcurrent. A zero or negative value disables the cap (returns the
// inner unchanged-shaped wrapper).
func New(inner review.Reviewer, maxConcurrent int) *Reviewer {
	if maxConcurrent <= 0 {
		return &Reviewer{inner: inner}
	}
	return &Reviewer{inner: inner, sem: make(chan struct{}, maxConcurrent)}
}

func (r *Reviewer) Name() string { return r.inner.Name() }

func (r *Reviewer) ReviewChunk(ctx context.Context, req review.ChunkRequest) (review.ChunkResponse, error) {
	if r.sem == nil {
		return r.inner.ReviewChunk(ctx, req)
	}
	select {
	case r.sem <- struct{}{}:
		defer func() { <-r.sem }()
	case <-ctx.Done():
		return review.ChunkResponse{}, ctx.Err()
	}
	return r.inner.ReviewChunk(ctx, req)
}

var _ review.Reviewer = (*Reviewer)(nil)
