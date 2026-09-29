package crawl

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

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
	yields map[string]domain.ShapeYield
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

func newFrontier(seeds []string, maxDepth int, yields map[string]domain.ShapeYield) *frontier {
	if yields == nil {
		yields = map[string]domain.ShapeYield{}
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
