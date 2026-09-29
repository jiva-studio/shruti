package crawl

import (
	"context"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Fetcher is the polite HTTP client, narrowed to what enumeration needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req domain.FetchRequest) (*domain.FetchResponse, error)
	Allowed(ctx context.Context, url string) bool
}

// Store is what a pass over one archive reads and writes.
type Store interface {
	Runs
	Schedule
}

// Runs is the record of each pass: opened before the walk, its counters
// written while it goes, closed with the tally when it finishes.
type Runs interface {
	StartRun(ctx context.Context, sourceID string, dryRun bool) (*domain.Run, error)
	SaveProgress(ctx context.Context, run *domain.Run) error
	FinishRun(ctx context.Context, run *domain.Run) error
}

// Schedule is what earlier visits say about where a pass should go: what each
// URL shape has yielded, which pages are due and which are not, and the links
// nobody has followed yet.
type Schedule interface {
	ShapeYields(ctx context.Context, sourceID string) (map[string]domain.ShapeYield, error)
	NotDueURLs(ctx context.Context, sourceID string, now time.Time) (map[string]bool, error)
	DuePages(ctx context.Context, sourceID string, now time.Time, limit int) ([]domain.Page, error)
	UnvisitedLinks(ctx context.Context, sourceID string, limit int) ([]string, error)
}

// Queue is the work waiting across every enabled archive, as the scheduler
// takes it.
//
// A claim is a read: an address keeps coming back until reading it has moved
// its next check on. Unreachable takes one out of the queue for good.
type Queue interface {
	ClaimWork(ctx context.Context, now time.Time, limit int) ([]domain.Work, error)
	Unreachable(ctx context.Context, url, reason string, now time.Time) error
}
