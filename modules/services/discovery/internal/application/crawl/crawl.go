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
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/index"
	"github.com/jiva-studio/lectorium/discovery/internal/application/parse"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/clock"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
	logpkg "github.com/jiva-studio/lectorium/discovery/internal/logging"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// Fetcher is the polite HTTP client, narrowed to what enumeration needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req fetch.Request) (*fetch.Response, error)
	Allowed(ctx context.Context, url string) bool
}

// Service runs one source at a time.
type Service struct {
	Index   *index.Service
	Parse   *parse.Service
	Fetcher Fetcher
	Repo    *store.Repo
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

// Run walks a source and returns the run record. It is Begin and Resume in one,
// for a caller that means to wait.
func (s *Service) Run(ctx context.Context, src *store.Source, opts Options) (*store.Run, error) {
	run, err := s.Begin(ctx, src, opts)
	if err != nil {
		return nil, err
	}
	return run, s.Resume(ctx, src, opts, run)
}

// Begin records that a pass is starting and returns it, so a caller that will
// not be waiting has something to poll.
func (s *Service) Begin(ctx context.Context, src *store.Source, opts Options) (*store.Run, error) {
	if opts.DryRun {
		return &store.Run{DryRun: true, Errors: map[string]int{}}, nil
	}
	return s.Repo.StartRun(ctx, src.ID, false)
}

// Resume does the walking. The run is filled in as it goes and written when it
// finishes.
func (s *Service) Resume(ctx context.Context, src *store.Source, opts Options, run *store.Run) error {
	if opts.Limit <= 0 {
		opts.Limit = defaultLimit
	}
	yields, err := s.Repo.ShapeYields(ctx, src.ID)
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
		notDue, err := s.Repo.NotDueURLs(ctx, src.ID, s.now())
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
		due, err := s.Repo.DuePages(ctx, src.ID, s.now(), opts.Limit)
		if err != nil {
			return err
		}
		for _, p := range due {
			frontier.add(p.URL, 0)
		}
		// A page that is not due still holds the route to what lies beyond it.
		// Those links come from the table rather than from fetching it again.
		unvisited, err := s.Repo.UnvisitedLinks(ctx, src.ID, opts.Limit)
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
	return s.Repo.FinishRun(ctx, run)
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
func (s *Service) walk(ctx context.Context, workers int, src *store.Source,
	opts Options, run *store.Run, frontier *frontier) {

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
					if err := s.Repo.SaveProgress(ctx, run); err != nil {
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
				if errors.Is(err, fetch.ErrCircuitOpen) || errors.Is(err, fetch.ErrRobotsUnread) {
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
// visit processes one URL and folds the outcome into the run counters.
//
// pages_fetched counts requests that actually reached the host. A refusal that
// never left the process — robots saying no, or a breaker that has dropped the
// host — is a failure, not a page, and counting it would make a run that
// fetched five pages report two hundred.
func (s *Service) visit(ctx context.Context, rawURL string, depth int, src *store.Source,
	opts Options, run *store.Run, frontier *frontier, mu *sync.Mutex) (err error) {

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
func (s *Service) recordErr(ctx context.Context, run *store.Run, rawURL string, err error) error {
	run.Failures++
	kind := errKind(err)
	run.Errors[kind]++
	slog.WarnContext(ctx, "crawl_page_failed", "url", rawURL, "kind", kind, "err", err.Error())
	return err
}

// visitedCount is what the loop budgets against: work attempted, whether or not
// it reached the host. Without it a run whose every request is refused would
// never stop.
func attempts(run *store.Run) int { return run.PagesFetched + run.Failures }

// sourceRequest is what every outbound call for this source carries: its
// credentials and the gap it asked to be left between requests.
func sourceRequest(src *store.Source) fetch.Request {
	return fetch.Request{
		Headers:  src.AuthHeaders,
		Tool:     src.Fetcher,
		MinDelay: time.Duration(src.CrawlDelayMS) * time.Millisecond,
	}
}

func errKind(err error) string { return fetch.Kind(err) }

// digits is what turns an address into a shape: /audios/7378 and /audios/4145
// are the same kind of page and should be judged together.
var digits = regexp.MustCompile(`[0-9]+`)

// urlShape is the address with its numbers blanked — the key everything about
// a page's likely worth is learned under.
//
// The address is decoded first: percent escapes carry digits of their own, and
// blanking those would turn %2F into %#F and group by an artefact of the
// encoding rather than by the shape of the path.
func urlShape(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	shape := u.Path
	if q, err := url.QueryUnescape(u.RawQuery); err == nil && q != "" {
		shape += "?" + q
	} else if u.RawQuery != "" {
		shape += "?" + u.RawQuery
	}
	return digits.ReplaceAllString(shape, "#")
}

const (
	// exploreScore is what an address of a shape we have never visited is
	// worth. It sits above a shape that has proved barren and below one that
	// has proved productive, so a site's scaffolding sinks while something new
	// still gets looked at. Without it a crawl would only ever revisit the
	// kinds of page it already knows and would never find a new one.
	exploreScore = 0.5
	// insideSeedBonus favours going further into where the crawl was pointed
	// over wandering out of it.
	//
	// A source seeded at one speaker's Bhagavad-gita is a request to index
	// that, not the archive around it. Left to the order links appear in, a
	// crawl walks straight out: the breadcrumb to the parent and the site root
	// sit above the chapter directories in the markup, so twelve pages went up
	// and sideways and never once went in.
	//
	// It is set above the whole range of the yield so that somewhere unexplored
	// inside the seed still outranks a proven shape outside it. A shape known
	// to be barren does not: nothing inside is worth visiting for its own sake.
	insideSeedBonus = 0.75
	// depthPenalty keeps a productive shape from being chased downwards
	// forever before anything else is looked at.
	depthPenalty = 0.05
)

// frontier is the queue of URLs left to visit, bounded to the seeds' hosts and
// to a depth, and refusing to visit anything twice.
//
// It is ordered by what pages of the same shape have actually yielded. Most of
// any site is scaffolding — menus, indexes, an account area — and a crawl that
// takes links in the order they appear spends its budget there: twenty pages
// from the root of one archive found nothing at all, while twenty from a page
// one level down found four hundred files.
type frontier struct {
	hosts    map[string]bool
	maxDepth int
	seen     map[string]bool
	queue    []frontierEntry
	// yields is what each shape has been worth so far, seeded from previous
	// runs and updated as this one goes.
	yields map[string]store.ShapeYield
	// insideSeed are the directory paths the seeds point at. Anything under
	// one of them is where this source was asked to look.
	insideSeed []string
	// notDue are pages whose next check has not come around. A link to one is
	// not followed: the schedule is what keeps a settled archive from being
	// refetched in full every time the scheduler ticks.
	notDue map[string]bool
	// mayFetch asks robots.txt before an address is queued. A section we are
	// not allowed into is a permanent answer, and queueing it anyway spends a
	// run's whole budget on refusals — every run, forever, because a refusal
	// leaves no page behind to remember it by.
	mayFetch func(string) bool
	// offLimits counts what mayFetch turned away, so a source that publishes
	// most of its links inside a forbidden section says so rather than looking
	// like a crawl that found nothing.
	offLimits int
}

type frontierEntry struct {
	url   string
	depth int
}

func newFrontier(seeds []string, maxDepth int, yields map[string]store.ShapeYield) *frontier {
	if yields == nil {
		yields = map[string]store.ShapeYield{}
	}
	// Zero means no bound: an archive is as deep as it is, and what stops a run
	// running away is its page limit, not a guess about somebody else's tree.
	f := &frontier{hosts: map[string]bool{}, maxDepth: maxDepth, seen: map[string]bool{}, yields: yields}
	for _, seed := range seeds {
		u, err := url.Parse(seed)
		if err != nil {
			continue
		}
		f.hosts[u.Host] = true
		f.insideSeed = append(f.insideSeed, seedScope(u))
	}
	return f
}

// seedScope is the part of an address a seed marks out as its own.
//
// For a path it is the directory the seed sits in; for a listing addressed
// through a query — which is how a file archive often does it — it is the
// whole thing, since there is no path to speak of.
func seedScope(u *url.URL) string {
	if u.RawQuery != "" {
		if q, err := url.QueryUnescape(u.RawQuery); err == nil {
			return u.Path + "?" + q
		}
		return u.Path + "?" + u.RawQuery
	}
	scope := u.Path
	if i := strings.LastIndex(strings.TrimSuffix(scope, "/"), "/"); i > 0 {
		scope = scope[:i+1]
	}
	return scope
}

// within reports whether an address lies inside what a seed marked out.
func (f *frontier) within(rawURL string) bool {
	if len(f.insideSeed) == 0 {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	here := u.Path
	if u.RawQuery != "" {
		if q, err := url.QueryUnescape(u.RawQuery); err == nil {
			here += "?" + q
		} else {
			here += "?" + u.RawQuery
		}
	}
	for _, scope := range f.insideSeed {
		if strings.HasPrefix(here, scope) {
			return true
		}
	}
	return false
}

// allowHostOf admits the name a page actually answered on.
//
// Redirecting the apex to www, or http to https, is ordinary; the links on the
// page that comes back are all under the name it redirected to. Only names
// reached by redirect from one already allowed are admitted, so this widens the
// crawl to the same site under another spelling and no further.
func (f *frontier) allowHostOf(rawURL string) {
	if rawURL == "" {
		return
	}
	if u, err := url.Parse(rawURL); err == nil && u.Host != "" {
		f.hosts[u.Host] = true
	}
}

// setNotDue records the pages whose next check has not come around, keyed the
// same way the queue is so that http and https cannot disagree about them.
func (f *frontier) setNotDue(urls map[string]bool) {
	f.notDue = make(map[string]bool, len(urls))
	for u := range urls {
		f.notDue[domain.URLKey(u)] = true
	}
}

func (f *frontier) add(rawURL string, depth int) {
	if f.maxDepth > 0 && depth > f.maxDepth {
		return
	}
	id := domain.URLKey(rawURL)
	if f.seen[id] || f.notDue[id] {
		return
	}
	u, err := url.Parse(rawURL)
	if err != nil || !f.hosts[u.Host] {
		return
	}
	f.seen[id] = true
	if f.mayFetch != nil && !f.mayFetch(rawURL) {
		f.offLimits++
		return
	}
	f.queue = append(f.queue, frontierEntry{url: rawURL, depth: depth})
}

func (f *frontier) addAll(urls []string, depth int) {
	for _, u := range urls {
		f.add(u, depth)
	}
}

// score is how promising an address looks: what pages of its shape have
// yielded, whether it goes further into what the source asked for, and a little
// against how deep it sits.
//
// The yield is capped at one. Uncapped, a shape holding twenty files a page
// would outweigh everything else put together, and a crawl pointed at one
// speaker would leave to go and fetch it. What matters for ordering is whether
// a shape produces recordings at all, not how many.
func (f *frontier) score(e frontierEntry) float64 {
	base := exploreScore
	if y, ok := f.yields[urlShape(e.url)]; ok && y.Pages > 0 {
		base = min(float64(y.Media)/float64(y.Pages), 1)
	}
	if f.within(e.url) {
		base += insideSeedBonus
	}
	return base - depthPenalty*float64(e.depth)
}

// record folds what a visit found into what its shape is worth, so the ordering
// improves during the run and not only between runs.
func (f *frontier) record(rawURL string, media int) {
	shape := urlShape(rawURL)
	y := f.yields[shape]
	y.Pages++
	y.Media += media
	f.yields[shape] = y
}

func (f *frontier) next() (string, int, bool) {
	if len(f.queue) == 0 {
		return "", 0, false
	}
	best := 0
	bestScore := f.score(f.queue[0])
	for i := 1; i < len(f.queue); i++ {
		if s := f.score(f.queue[i]); s > bestScore {
			best, bestScore = i, s
		}
	}
	e := f.queue[best]
	f.queue = append(f.queue[:best], f.queue[best+1:]...)
	return e.url, e.depth, true
}
