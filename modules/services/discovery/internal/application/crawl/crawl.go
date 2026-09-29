// Package crawl walks a source: work out which pages exist, then hand each to
// the write path.
//
// Enumeration is whatever the host offers. A sitemap is used when there is
// one, because it is a complete list for two requests; otherwise links are
// followed from the seed. Neither route knows anything about the site.
package crawl

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/clock"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	logpkg "github.com/jiva-studio/shruti/logging"
)

// Service runs one source at a time.
type Service struct {
	Index   *index.Service
	Parse   *parse.Service
	Fetcher Fetcher
	Store   Store
	Now     func() time.Time

	// sitemaps remembers what each host's sitemap listed, so an idle tick does
	// not re-download a catalogue that changes monthly at best.
	sitemaps *sitemapCache
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return clock.UTC()
}

// Options control one pass.
type Options struct {
	// DryRun reads and normalizes but writes nothing and schedules nothing.
	DryRun bool
	// Limit caps how many pages this pass will fetch. Always set: an
	// unbounded walk of a 260,000-file archive is not something to start by
	// accident.
	Limit int
	// Full ignores the recheck schedule and sweeps from the seeds again.
	Full bool
	// Workers overrides the source's own setting for this pass.
	Workers int
	// Stop, once closed, means: finish the page in hand and take no more. It is
	// not the context, and that is the point — cancelling the context aborts the
	// writes that page is in the middle of, which is what shutting down
	// gracefully is supposed to avoid.
	Stop <-chan struct{}
}

// stopped reports whether a stop signal has been given. A nil channel never
// has, so a caller that does not mean to stop anything passes nothing.
func stopped(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// defaultLimit is deliberately small. Widening it is a decision someone makes
// on purpose.
const defaultLimit = 200

// progressEvery is how often a run's counters are written while it is going.
// Often enough that a restart loses little, rarely enough to be free.
const progressEvery = 25

// Begin records that a pass is starting and returns it, so a caller that will
// not be waiting has something to poll.
func (s *Service) Begin(ctx context.Context, src *domain.Archive, opts Options) (*domain.Run, error) {
	if opts.DryRun {
		return &domain.Run{DryRun: true, Errors: map[string]int{}}, nil
	}
	return s.Store.StartRun(ctx, src.ID, false)
}

// Resume does the walking. The run is filled in as it goes and written when it
// finishes.
func (s *Service) Resume(ctx context.Context, src *domain.Archive, opts Options, run *domain.Run) error {
	if opts.Limit <= 0 {
		opts.Limit = defaultLimit
	}
	yields, err := s.Store.ShapeYields(ctx, src.ID)
	if err != nil {
		return err
	}
	frontier := newFrontier(src.SeedURLs, src.MaxDepth, yields)
	if s.Fetcher != nil {
		frontier.mayFetch = func(u string) bool { return s.Fetcher.Allowed(ctx, u) }
	}
	// A full sweep is a deliberate request to ignore the schedule; an ordinary
	// pass honours it, for links as much as for where it starts.
	if !opts.Full {
		notDue, err := s.Store.NotDueURLs(ctx, src.ID, s.now())
		if err != nil {
			return err
		}
		frontier.setNotDue(notDue)
	}
	for _, seed := range src.SeedURLs {
		frontier.add(seed, 0)
		// A sitemap catalogues the whole site. A source pointed at one
		// speaker's Bhagavad-gita wants its part of it and not the other four
		// hundred addresses: preferring what is inside only orders the queue,
		// and once everything inside is up to date the rest is all that is
		// left, so the crawl wanders off into the archive.
		for _, u := range s.SitemapURLs(ctx, seed, sourceRequest(src)) {
			if frontier.within(u) {
				frontier.add(u, 1)
			}
		}
	}
	if !opts.Full && !opts.DryRun {
		due, err := s.Store.DuePages(ctx, src.ID, s.now(), opts.Limit)
		if err != nil {
			return err
		}
		for _, p := range due {
			frontier.add(p.URL, 0)
		}
		// A page that is not due still holds the route to what lies beyond it.
		// Those links come from the table rather than from fetching it again.
		unvisited, err := s.Store.UnvisitedLinks(ctx, src.ID, opts.Limit)
		if err != nil {
			return err
		}
		for _, u := range unvisited {
			frontier.add(u, 0)
		}
	}

	workers := src.CrawlWorkers
	if opts.Workers > 0 {
		workers = opts.Workers
	}
	if workers <= 0 {
		workers = 1
	}
	s.walk(ctx, workers, src, opts, run, frontier)
	if frontier.offLimits > 0 {
		slog.InfoContext(ctx, "crawl_skipped_off_limits",
			"source", src.ID, "addresses", frontier.offLimits)
	}

	if opts.DryRun {
		return nil
	}
	// A pass cut short by shutdown is not a pass that finished. The row is left
	// open on purpose: the next boot marks it interrupted, which is what
	// happened. Closing it here would file a partial sweep as a complete one,
	// and every page it never reached would look up to date.
	if stopped(opts.Stop) {
		return ErrStopped
	}
	return s.Store.FinishRun(ctx, run)
}

// walk works the frontier with several pages in flight at once.
//
// The gap between requests is what bounds how hard a host is leaned on, and it
// is enforced per host inside the fetcher; workers only stop us idling through
// somebody else's round trip. A source with no gap at all is where they earn
// their keep, because then nothing else limits the rate.
//
// The frontier and the run counters are shared, so both are held under one
// lock: a queue ordered by what each shape has yielded is not something to
// interleave unguarded.
func (s *Service) walk(ctx context.Context, workers int, src *domain.Archive,
	opts Options, run *domain.Run, frontier *frontier) {

	// halted ends the walk early when a host has dropped us. A channel rather
	// than a cancelled context, for the same reason as Options.Stop: ending the
	// walk must not abort the page another worker is in the middle of writing.
	halted := make(chan struct{})
	var once sync.Once
	halt := func() { once.Do(func() { close(halted) }) }

	var mu sync.Mutex
	var wg sync.WaitGroup

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if stopped(halted) || stopped(opts.Stop) || ctx.Err() != nil {
					return
				}
				mu.Lock()
				if attempts(run) >= opts.Limit {
					mu.Unlock()
					return
				}
				next, depth, ok := frontier.next()
				if !ok {
					mu.Unlock()
					return
				}
				due := !opts.DryRun && attempts(run) > 0 && attempts(run)%progressEvery == 0
				mu.Unlock()

				if due {
					if err := s.Store.SaveProgress(ctx, run); err != nil {
						slog.WarnContext(ctx, "run_progress_not_saved", "run", run.ID, "err", err.Error())
					}
				}

				err := s.visit(ctx, next, depth, src, opts, run, frontier, &mu)
				if err == nil {
					continue
				}
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return
				}
				// The host is not answering us and will not be for a while —
				// either it has been dropped for its cooldown, or it never told
				// us its rules. Carrying on would spend the rest of the budget
				// on refusals in a few seconds, and every other worker is about
				// to hit the same wall.
				if errors.Is(err, domain.ErrCircuitOpen) || errors.Is(err, domain.ErrRobotsUnread) {
					slog.WarnContext(ctx, "crawl_stopped_host_unavailable",
						"source", src.ID, "url", next, "reason", errKind(err),
						"pages_fetched", run.PagesFetched)
					halt()
					return
				}
			}
		}()
	}
	wg.Wait()
}

// visit processes one URL and folds the outcome into the run counters.
func (s *Service) visit(ctx context.Context, rawURL string, depth int, src *domain.Archive,
	opts Options, run *domain.Run, frontier *frontier, mu *sync.Mutex) (err error) {

	// A panic reading one page is that page's failure, not the run's and not
	// the process's. It is counted like any other so a document that keeps
	// doing it is visible rather than silent.
	defer func() {
		if r := recover(); r != nil {
			logpkg.Panicked(ctx, "crawl_visit", r)
			mu.Lock()
			defer mu.Unlock()
			err = s.recordErr(ctx, run, rawURL, fmt.Errorf("panic: %v", r))
		}
	}()

	if opts.DryRun {
		layers, err := s.Parse.URL(ctx, rawURL, sourceRequest(src))
		mu.Lock()
		defer mu.Unlock()
		if err != nil {
			return s.recordErr(ctx, run, rawURL, err)
		}
		run.PagesFetched++
		run.ItemsFound += len(layers.Extracted.Items)
		frontier.record(rawURL, len(layers.Extracted.Items))
		frontier.allowHostOf(layers.Extracted.URL)
		frontier.addAll(layers.Extracted.Links, depth+1)
		return nil
	}

	report, err := s.Index.Item(ctx, rawURL, src.ID, opts.Full)
	mu.Lock()
	defer mu.Unlock()
	if err != nil {
		return s.recordErr(ctx, run, rawURL, err)
	}
	run.PagesFetched++
	run.ItemsFound += report.ItemsFound
	run.ItemsNew += report.ItemsNew
	run.ItemsChanged += report.ItemsNormalized
	if report.Unchanged {
		run.PagesUnchanged++
	}
	frontier.record(rawURL, report.ItemsFound)
	frontier.allowHostOf(report.FinalURL)
	frontier.addAll(report.Links, depth+1)
	return nil
}

// recordErr keeps a tally by kind rather than a list, so a run summary stays
// readable when one host is having a bad day. The tally alone has twice been
// too little to work from — a count of failures says nothing about whether a
// site is refusing us or a link is dead — so each one also says what happened.
func (s *Service) recordErr(ctx context.Context, run *domain.Run, rawURL string, err error) error {
	run.Failures++
	kind := errKind(err)
	run.Errors[kind]++
	slog.WarnContext(ctx, "crawl_page_failed", "url", rawURL, "kind", kind, "err", err.Error())
	return err
}

// visitedCount is what the loop budgets against: work attempted, whether or not
// it reached the host. Without it a run whose every request is refused would
// never stop.
func attempts(run *domain.Run) int { return run.PagesFetched + run.Failures }

// sourceRequest is what every outbound call for this source carries: its
// credentials and the gap it asked to be left between requests.
func sourceRequest(src *domain.Archive) domain.FetchRequest {
	return domain.FetchRequest{
		Headers:  src.AuthHeaders,
		Tool:     src.Fetcher,
		MinDelay: time.Duration(src.CrawlDelayMS) * time.Millisecond,
	}
}

func errKind(err error) string { return domain.FetchErrorKind(err) }
