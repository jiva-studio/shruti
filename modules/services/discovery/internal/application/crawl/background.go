package crawl

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	logpkg "github.com/jiva-studio/lectorium/discovery/internal/logging"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// ErrAlreadyRunning means this source is already being walked.
var ErrAlreadyRunning = errors.New("crawl: a run over this source is already going")

// ErrStopped means the pass put down its work because the service is shutting
// down. Not a failure: the run row stays open and the next boot says so.
var ErrStopped = errors.New("crawl: stopped before the pass finished")

// Background runs a hand-triggered pass outside the request that asked for it.
//
// A crawl takes as long as the archive takes — one backfill of a single channel
// ran eight minutes — and holding an HTTP request open for that is wrong twice
// over. The client hanging up cancels the context and kills the run half
// written; and SIGTERM cannot land, because a graceful shutdown waits for
// in-flight requests and then gives up, so a deploy during a crawl looks like
// a crash.
//
// So the request creates the run, gets its id, and returns. What happens next
// is watched through /discovery/runs/{id}.
type Background struct {
	Service *Service

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// stop says "take no more pages"; ctx says "drop what you are holding". A
	// graceful shutdown uses the first and reaches for the second only when the
	// first has run out of time.
	stop     chan struct{}
	stopOnce sync.Once

	mu      sync.Mutex
	running map[string]int64
}

func NewBackground(svc *Service) *Background {
	ctx, cancel := context.WithCancel(context.Background())
	return &Background{
		Service: svc, ctx: ctx, cancel: cancel,
		running: map[string]int64{},
		stop:    make(chan struct{}),
	}
}

// Start records the run, hands back its id, and walks the source from a
// goroutine.
//
// One run per source at a time. Two walks of one archive halve nobody's
// politeness — the per-host gap is shared — but they duplicate every request
// and write each other's counters, and the usual way to get one is pressing a
// button twice.
func (b *Background) Start(src *store.Source, opts Options) (*store.Run, error) {
	b.mu.Lock()
	if id, busy := b.running[src.ID]; busy {
		b.mu.Unlock()
		return &store.Run{ID: id}, ErrAlreadyRunning
	}
	b.mu.Unlock()

	// The run stops when the service does, so it puts down what it is holding
	// rather than being cut off mid-page.
	opts.Stop = b.stop

	// The row is written before returning, so the caller is given something to
	// poll rather than a promise.
	run, err := b.Service.Begin(b.ctx, src, opts)
	if err != nil {
		return nil, err
	}

	b.mu.Lock()
	if id, busy := b.running[src.ID]; busy {
		b.mu.Unlock()
		return &store.Run{ID: id}, ErrAlreadyRunning
	}
	b.running[src.ID] = run.ID
	b.mu.Unlock()

	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		defer func() {
			b.mu.Lock()
			delete(b.running, src.ID)
			b.mu.Unlock()
		}()
		// Every line this run writes carries its id. Two passes over different
		// sources interleave in the log otherwise, and there is nothing in a
		// line that says which is which.
		runCtx := logpkg.WithRunID(b.ctx, run.ID)

		// A run that panics is a run that ended. Without this it is the whole
		// service that ended, because nothing above this goroutine can catch it.
		defer logpkg.Recovered(runCtx, "background_run")

		if err := b.Service.Resume(runCtx, src, opts, run); err != nil {
			// Shutting down is not a failure, and reading it as one in the log
			// sends somebody looking for a broken archive. The row is left open
			// on purpose: the next boot marks it interrupted, which is what
			// happened.
			if errors.Is(err, ErrStopped) || b.ctx.Err() != nil {
				slog.InfoContext(context.Background(), "run_interrupted",
					"source", src.ID, "run", run.ID, "pages", run.PagesFetched)
				return
			}
			slog.ErrorContext(runCtx, "run_failed", "source", src.ID, "run", run.ID, "err", err.Error())
			return
		}
		slog.InfoContext(runCtx, "run_done", "source", src.ID, "run", run.ID,
			"pages", run.PagesFetched, "items_new", run.ItemsNew, "failures", run.Failures)
	}()
	return run, nil
}

// Shutdown stops the runs and waits for them to put down what they were
// holding.
//
// Two stages, and the order is the whole of it. Closing stop means "finish the
// page in hand and take no more", and the context stays alive so that page's
// writes can land — abandoning them would leave a page written and its records
// not. Only when the drain runs past its deadline is the context cancelled, and
// by then the choice is between a half-written page and a container the
// orchestrator kills anyway.
func (b *Background) Shutdown(within time.Duration) {
	b.stopOnce.Do(func() { close(b.stop) })

	done := make(chan struct{})
	go func() { b.wg.Wait(); close(done) }()

	select {
	case <-done:
	case <-time.After(within):
		slog.WarnContext(context.Background(), "background_drain_timeout",
			"waited", within.String())
		b.cancel()
		<-done
	}
	b.cancel()
}
