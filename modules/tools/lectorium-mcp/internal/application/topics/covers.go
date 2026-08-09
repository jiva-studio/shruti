package topics

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/covergen"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

var errCoverNotConfigured = errors.New("image generation is not configured (set images.api_key)")

const (
	// defaultCoverConcurrency caps simultaneous image generations.
	defaultCoverConcurrency = 4
	// defaultCoverRetries is how many attempts one cover gets on a transient
	// image/upload error before it's recorded as failed (the batch continues).
	defaultCoverRetries = 3
)

// TopicCoverLister enumerates topics and their current cover status.
type TopicCoverLister interface {
	ListTopicCovers(ctx context.Context) ([]catalog.TopicCover, error)
}

// CoverGenerator generates and stores one entity's cover. covergen.UseCase
// satisfies this (kept as an interface so the batch is unit-testable).
type CoverGenerator interface {
	Enabled() bool
	Generate(ctx context.Context, id, language, extra string, opts ...covergen.Option) (string, error)
}

// CoverBuildUseCase generates covers for every topic as one batch: list topics,
// skip those that already have a cover (unless Force), and fan the generation
// out with bounded concurrency + per-cover retry. Best-effort — one topic's
// failure is recorded, not fatal, so a long run isn't lost to a single hiccup,
// and re-running (Force=false) only fills the gaps.
type CoverBuildUseCase struct {
	Lister TopicCoverLister
	Cover  CoverGenerator

	// Concurrency / Retries tune the fan-out. Zero falls back to the defaults.
	Concurrency int
	Retries     int
}

// CoverBuildResult summarizes a batch run.
type CoverBuildResult struct {
	Total     int      `json:"total"`     // topics attempted this run
	Generated int      `json:"generated"` // covers successfully produced
	Skipped   int      `json:"skipped"`   // already had a cover (Force=false)
	Failed    int      `json:"failed"`    // attempted but errored after retries
	FailedIDs []string `json:"failedIds,omitempty"`
}

// CoverProgressFn is called after each topic finishes (success or failure) with
// the running done/total counts so the caller can report progress.
type CoverProgressFn func(done, total, failed int)

// Plan returns the topic ids this run would attempt, honoring Force and limit.
// Lets the caller report an accurate total up front.
func (uc CoverBuildUseCase) Plan(ctx context.Context, force bool, limit int) ([]string, int, error) {
	all, err := uc.Lister.ListTopicCovers(ctx)
	if err != nil {
		return nil, 0, err
	}
	skipped := 0
	var todo []string
	for _, t := range all {
		if !force && t.HasCover {
			skipped++
			continue
		}
		todo = append(todo, t.ID)
		if limit > 0 && len(todo) >= limit {
			break
		}
	}
	return todo, skipped, nil
}

// Run generates covers for the planned topics. language/extra steer the prompt
// (forwarded to the generator). onProgress, when set, is called after each topic.
func (uc CoverBuildUseCase) Run(
	ctx context.Context,
	force bool,
	limit int,
	language, extra string,
	onProgress CoverProgressFn,
) (CoverBuildResult, error) {
	if !uc.Cover.Enabled() {
		return CoverBuildResult{}, errCoverNotConfigured
	}
	todo, skipped, err := uc.Plan(ctx, force, limit)
	if err != nil {
		return CoverBuildResult{}, err
	}
	total := len(todo)

	conc := uc.Concurrency
	if conc <= 0 {
		conc = defaultCoverConcurrency
	}
	retries := uc.Retries
	if retries <= 0 {
		retries = defaultCoverRetries
	}

	var generated, doneCount int64
	var mu sync.Mutex
	var failedIDs []string

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(conc)
	for _, id := range todo {
		id := id
		g.Go(func() error {
			err := uc.generateWithRetry(gctx, id, language, extra, retries)
			if err != nil {
				// A cancelled context aborts the whole batch; an individual
				// generation failure is recorded and the batch carries on.
				if gctx.Err() != nil {
					return gctx.Err()
				}
				mu.Lock()
				failedIDs = append(failedIDs, id)
				mu.Unlock()
			} else {
				atomic.AddInt64(&generated, 1)
			}
			d := atomic.AddInt64(&doneCount, 1)
			if onProgress != nil {
				mu.Lock()
				f := len(failedIDs)
				mu.Unlock()
				onProgress(int(d), total, f)
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return CoverBuildResult{}, err
	}

	return CoverBuildResult{
		Total:     total,
		Generated: int(generated),
		Skipped:   skipped,
		Failed:    len(failedIDs),
		FailedIDs: failedIDs,
	}, nil
}

func (uc CoverBuildUseCase) generateWithRetry(ctx context.Context, id, language, extra string, attempts int) error {
	var lastErr error
	for a := 0; a < attempts; a++ {
		if a > 0 {
			backoff := time.Duration(1<<uint(a-1)) * time.Second // 1s, 2s, 4s…
			if backoff > 8*time.Second {
				backoff = 8 * time.Second
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}
		if _, err := uc.Cover.Generate(ctx, id, language, extra); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}
