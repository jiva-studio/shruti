package crawl

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/index"
	"github.com/jiva-studio/lectorium/discovery/internal/clock"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
	logpkg "github.com/jiva-studio/lectorium/discovery/internal/logging"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// Scheduler keeps the overdue work drained.
//
// It is not a periodic job and does not walk sources in turn. The queue is
// already in the database — addresses nobody has visited, and pages whose next
// check has come around — and this takes from it until there is nothing left,
// then waits and looks again.
//
// The reason there is no batch here: a batch would be a second rate limiter on
// top of the only one that means anything. What bounds how hard a host is
// leaned on is the gap between requests, and that lives in the fetcher, per
// host. A tick on top of it only adds latency to work that was already due, and
// makes two sources on different hosts wait for each other though neither can
// disturb the other.
//
// It exists only when switched on, and even then takes work only from sources
// that are themselves enabled — starting the service must not touch anybody's
// website.
type Scheduler struct {
	Index   *index.Service
	Repo    *store.Repo
	Fetcher Fetcher
	// Workers is how many pages may be in flight at once, across every source.
	// It only stops us idling through somebody else's round trip; it is not what
	// bounds the rate.
	Workers int
	// PageTimeout bounds one page end to end. Every step below has its own
	// timeout and they stack — a fetch with retries, then the model with
	// retries, then the embedder per batch — so without a ceiling here one page
	// can hold a worker and a database connection for the better part of an
	// hour. Zero means no ceiling, which is only right for a test.
	PageTimeout time.Duration
	Now         func() time.Time

	// inFlight is what is being read right now. A claim is a plain read and
	// keeps returning an address until reading it has moved the address on, so
	// without this the same page goes to several workers at once — which is a
	// wasted request to somebody's site and two transactions writing the same
	// rows.
	mu       sync.Mutex
	inFlight map[string]bool

	// stopped is closed by Stop. A nil channel — a Scheduler built by hand in a
	// test — never fires, which is the right answer for one that is not running.
	stopped  chan struct{}
	stopOnce sync.Once
}

// NewScheduler builds a scheduler that can be stopped.
func NewScheduler(idx *index.Service, repo *store.Repo, f Fetcher, workers int, pageTimeout time.Duration) *Scheduler {
	return &Scheduler{
		Index: idx, Repo: repo, Fetcher: f, Workers: workers,
		PageTimeout: pageTimeout,
		inFlight:    map[string]bool{},
		stopped:     make(chan struct{}),
	}
}

// Stop tells the scheduler to take no more work.
//
// It deliberately cancels nothing. The context the workers write under belongs
// to the caller, and cancelling it is exactly how a page ends up written half
// way — which is the thing a graceful shutdown exists to prevent. Stopping and
// cancelling are two separate acts, and the caller decides whether the second
// one is ever warranted.
func (s *Scheduler) Stop() {
	s.stopOnce.Do(func() {
		if s.stopped != nil {
			close(s.stopped)
		}
	})
}

// halted reports whether Stop has been called.
func (s *Scheduler) halted() bool {
	select {
	case <-s.stopped:
		return true
	default:
		return false
	}
}

// rest waits, and reports whether it got to finish rather than being stopped or
// cancelled.
func (s *Scheduler) rest(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-s.stopped:
		return false
	case <-ctx.Done():
		return false
	}
}

// take reports whether this address is ours to read, and marks it taken.
func (s *Scheduler) take(url string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight[url] {
		return false
	}
	if s.inFlight == nil {
		s.inFlight = map[string]bool{}
	}
	s.inFlight[url] = true
	return true
}

func (s *Scheduler) release(url string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.inFlight, url)
}

const (
	// idleWait is how long to wait after finding nothing. It exists so an idle
	// service is quiet, and bounds nothing about a busy one.
	idleWait = 15 * time.Second
	// claimBatch is how much work is taken from the database at a time. It is a
	// read-ahead, not a budget: the loop comes straight back for more.
	claimBatch = 200
	// hostRest is how long a host that has just refused us is left alone. It
	// matches the breaker's own cooldown, so the queue does not spend itself
	// discovering the same closed door.
	hostRest = 5 * time.Minute
)

func (s *Scheduler) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return clock.UTC()
}

// Run drains the queue until Stop is called, and returns once every worker has
// finished what it was holding.
//
// The context is what the work is done under, not the stop signal. It is
// cancelled only as a last resort, by a caller that has waited for the drain
// and given up.
func (s *Scheduler) Run(ctx context.Context) {
	workers := s.Workers
	if workers <= 0 {
		workers = 1
	}

	work := make(chan store.Work)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for w := range work {
				s.visit(ctx, w)
			}
		}()
	}

	slog.InfoContext(ctx, "scheduler_started", "workers", workers)
	s.feed(ctx, work)
	close(work)
	wg.Wait()
	slog.InfoContext(ctx, "scheduler_stopped")
}

// feed claims work and hands it out until the scheduler is stopped.
func (s *Scheduler) feed(ctx context.Context, work chan<- store.Work) {
	for {
		if s.halted() || ctx.Err() != nil {
			return
		}
		claimed, err := s.Repo.ClaimWork(ctx, s.now(), claimBatch)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.ErrorContext(ctx, "scheduler_claim_failed", "err", err.Error())
			if !s.rest(ctx, idleWait) {
				return
			}
			continue
		}
		if len(claimed) == 0 {
			if !s.rest(ctx, idleWait) {
				return
			}
			continue
		}
		handed := 0
		for _, w := range claimed {
			if !s.take(w.URL) {
				continue
			}
			handed++
			select {
			case work <- w:
			case <-s.stopped:
				s.release(w.URL)
				return
			case <-ctx.Done():
				s.release(w.URL)
				return
			}
		}
		// Every address in the claim is already being read. Coming straight back
		// for the same list would spin.
		if handed == 0 && !s.rest(ctx, idleWait) {
			return
		}
	}
}

// visit reads one address and lets the write path reschedule it.
//
// A panic here is contained to this page. The alternative is that one malformed
// document on one archive takes down a service that is drained continuously and
// unattended.
func (s *Scheduler) visit(ctx context.Context, w store.Work) {
	defer s.release(w.URL)
	defer logpkg.Recovered(ctx, "scheduler_visit")

	if s.PageTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.PageTimeout)
		defer cancel()
	}

	// An address inside a section robots.txt closed after we had already
	// recorded pages under it would otherwise fill every claim and be dropped
	// afterwards, starving the work that could have been done. Taking it out of
	// the queue is what ends that.
	if s.Fetcher != nil && !s.Fetcher.Allowed(ctx, w.URL) {
		if err := s.Repo.Unreachable(ctx, w.URL, fetch.ErrDisallowed.Error(), s.now()); err != nil {
			slog.WarnContext(ctx, "scheduler_unreachable_not_recorded",
				"url", w.URL, "err", err.Error())
		}
		return
	}

	_, err := s.Index.Item(ctx, w.URL, w.SourceID, false)
	if err == nil {
		return
	}
	if ctx.Err() != nil {
		return
	}
	slog.WarnContext(ctx, "scheduler_page_failed",
		"url", w.URL, "source", w.SourceID, "kind", errKind(err), "err", err.Error())

	// A host that has dropped us, or that never said what it allows, will not
	// answer for a while. A bounded run stops here to protect its budget; a
	// continuous one has none to protect, so it rests and carries on — the rest
	// is what keeps it from spending itself on the same closed door.
	if errors.Is(err, fetch.ErrCircuitOpen) || errors.Is(err, fetch.ErrRobotsUnread) {
		s.rest(ctx, hostRest)
	}
}
