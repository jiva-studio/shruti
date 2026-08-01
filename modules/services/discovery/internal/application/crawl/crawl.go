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
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Fetcher is the polite HTTP client, narrowed to what enumeration needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req fetch.Request) (*fetch.Response, error)
}

// Service runs one source at a time.
type Service struct {
	Index   *index.Service
	Parse   *parse.Service
	Fetcher Fetcher
	Repo    *store.Repo
	Now     func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now().UTC()
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
}

// defaultLimit is deliberately small. Widening it is a decision someone makes
// on purpose.
const defaultLimit = 200

// Run walks a source and returns the run record.
func (s *Service) Run(ctx context.Context, src *store.Source, opts Options) (*store.Run, error) {
	if opts.Limit <= 0 {
		opts.Limit = defaultLimit
	}
	run := &store.Run{DryRun: opts.DryRun, Errors: map[string]int{}}
	if !opts.DryRun {
		started, err := s.Repo.StartRun(ctx, src.ID, opts.DryRun)
		if err != nil {
			return nil, err
		}
		run = started
	}

	yields, err := s.Repo.ShapeYields(ctx, src.ID)
	if err != nil {
		return nil, err
	}
	frontier := newFrontier(src.SeedURLs, src.MaxDepth, yields)
	for _, seed := range src.SeedURLs {
		frontier.add(seed, 0)
		for _, u := range s.SitemapURLs(ctx, seed, sourceRequest(src)) {
			frontier.add(u, 1)
		}
	}
	if !opts.Full && !opts.DryRun {
		due, err := s.Repo.DuePages(ctx, src.ID, s.now(), opts.Limit)
		if err != nil {
			return nil, err
		}
		for _, p := range due {
			frontier.add(p.URL, 0)
		}
	}

	for attempts(run) < opts.Limit {
		next, depth, ok := frontier.next()
		if !ok {
			break
		}
		if err := s.visit(ctx, next, depth, src, opts, run, frontier); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				break
			}
			// The host has been dropped and will stay dropped for its
			// cooldown. Carrying on would spend the rest of the budget on
			// refusals in a few seconds and report them as pages fetched.
			if errors.Is(err, fetch.ErrCircuitOpen) {
				slog.WarnContext(ctx, "crawl_stopped_host_cooling_down",
					"source", src.ID, "url", next, "pages_fetched", run.PagesFetched)
				break
			}
		}
	}

	if opts.DryRun {
		return run, nil
	}
	return run, s.Repo.FinishRun(ctx, run)
}

// visit processes one URL and folds the outcome into the run counters.
// visit processes one URL and folds the outcome into the run counters.
//
// pages_fetched counts requests that actually reached the host. A refusal that
// never left the process — robots saying no, or a breaker that has dropped the
// host — is a failure, not a page, and counting it would make a run that
// fetched five pages report two hundred.
func (s *Service) visit(ctx context.Context, rawURL string, depth int, src *store.Source,
	opts Options, run *store.Run, frontier *frontier) error {

	if opts.DryRun {
		layers, err := s.Parse.URL(ctx, rawURL, sourceRequest(src))
		if err != nil {
			return s.recordErr(run, err)
		}
		run.PagesFetched++
		run.ItemsFound += len(layers.Extracted.Items)
		frontier.record(rawURL, len(layers.Extracted.Items))
		frontier.allowHostOf(layers.Extracted.URL)
		frontier.addAll(layers.Extracted.Links, depth+1)
		return nil
	}

	report, err := s.Index.Item(ctx, rawURL, src.ID, opts.Full)
	if err != nil {
		return s.recordErr(run, err)
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
// readable when one host is having a bad day.
func (s *Service) recordErr(run *store.Run, err error) error {
	run.Failures++
	run.Errors[errKind(err)]++
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
		MinDelay: time.Duration(src.CrawlDelayMS) * time.Millisecond,
	}
}

func errKind(err error) string {
	switch {
	case errors.Is(err, fetch.ErrDisallowed):
		return "disallowed"
	case errors.Is(err, fetch.ErrCircuitOpen):
		return "circuit_open"
	case errors.Is(err, fetch.ErrTooLarge):
		return "too_large"
	default:
		return "fetch_failed"
	}
}

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
}

type frontierEntry struct {
	url   string
	depth int
}

func newFrontier(seeds []string, maxDepth int, yields map[string]store.ShapeYield) *frontier {
	if yields == nil {
		yields = map[string]store.ShapeYield{}
	}
	f := &frontier{hosts: map[string]bool{}, maxDepth: maxDepth, seen: map[string]bool{}, yields: yields}
	if f.maxDepth <= 0 {
		f.maxDepth = 6
	}
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

func (f *frontier) add(rawURL string, depth int) {
	if depth > f.maxDepth || f.seen[rawURL] {
		return
	}
	u, err := url.Parse(rawURL)
	if err != nil || !f.hosts[u.Host] {
		return
	}
	f.seen[rawURL] = true
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

// Scheduler is the periodic crawl. It exists only when switched on, and even
// then it walks only sources that are themselves enabled — starting the
// service must not touch anybody's website.
type Scheduler struct {
	Service  *Service
	Repo     *store.Repo
	Interval time.Duration
	Limit    int
}

// Start runs until the context is cancelled. A failing source is logged and
// the next one is tried; one bad archive does not stop the rest.
func (s *Scheduler) Start(ctx context.Context) {
	ticker := time.NewTicker(s.Interval)
	defer ticker.Stop()

	for {
		s.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Scheduler) tick(ctx context.Context) {
	sources, err := s.Repo.Sources(ctx)
	if err != nil {
		slog.ErrorContext(ctx, "scheduler_sources_failed", "err", err.Error())
		return
	}
	for i := range sources {
		if !sources[i].Enabled {
			continue
		}
		run, err := s.Service.Run(ctx, &sources[i], Options{Limit: s.Limit})
		if err != nil {
			slog.ErrorContext(ctx, "scheduler_run_failed", "source", sources[i].ID, "err", err.Error())
			continue
		}
		slog.InfoContext(ctx, "scheduler_run_done",
			"source", sources[i].ID, "pages", run.PagesFetched,
			"items_new", run.ItemsNew, "failures", run.Failures)
	}
}
