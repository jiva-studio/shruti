package fetch

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/temoto/robotstxt"
)

const (
	// robotsTTL is how long an answer is trusted.
	robotsTTL = 24 * time.Hour
	// robotsRetryTTL is how long a non-answer is kept.
	//
	// A host that could not serve its robots.txt has not refused us; it has
	// said nothing, and the two must not be remembered for the same length of
	// time. Trusting silence for a day drops a whole archive out of the crawl
	// over one bad minute, and reports it as the archive's decision.
	robotsRetryTTL = 5 * time.Minute
	// robotsMaxBytes is the parse limit RFC 9309 asks crawlers to honour.
	robotsMaxBytes = 500 << 10
	// robotsTimeout bounds the robots.txt fetch itself.
	robotsTimeout = 10 * time.Second
)

// robotsEntry is one host's rules and when they were read. A nil data is a host
// that did not answer, which is why known() exists: there is nothing to test a
// path against, and pretending the answer was "no" loses that distinction.
type robotsEntry struct {
	data   *robotstxt.RobotsData
	group  *robotstxt.Group
	agent  string
	readAt time.Time
	ttl    time.Duration
}

func (e *robotsEntry) expired(now time.Time) bool {
	return e == nil || now.Sub(e.readAt) > e.ttl
}

// known reports whether this host told us its rules.
func (e *robotsEntry) known() bool { return e != nil && e.data != nil }

// allows reports whether the path may be fetched. The blanket allow a 4xx
// implies lives on the document, not on any group, so the test has to go
// through the document.
func (e *robotsEntry) allows(path string) bool {
	if !e.known() {
		return false
	}
	return e.data.TestAgent(path, e.agent)
}

// crawlDelay is the gap this host asked for, or zero if it asked for none.
func (e *robotsEntry) crawlDelay() time.Duration {
	if e == nil || e.group == nil {
		return 0
	}
	return e.group.CrawlDelay
}

// robotsHost is one origin's cached rules and the lock that keeps two workers
// from asking for them at the same moment. Reading robots.txt four times
// because four workers started together is exactly the impoliteness the file
// exists to prevent.
type robotsHost struct {
	mu    sync.Mutex
	entry *robotsEntry
}

// robotsCache reads and remembers robots.txt per host.
//
// A host that answers 4xx has no rules and everything is allowed. A host that
// answers 429 or 5xx, or does not answer at all, has given no permission and
// nothing is fetched from it — but only until robotsRetryTTL is up, because
// that is a state we are waiting out rather than a decision we were given.
type robotsCache struct {
	agent  string
	client *http.Client

	mu    sync.Mutex
	hosts map[string]*robotsHost
	now   func() time.Time
}

func newRobotsCache(agent string) *robotsCache {
	return &robotsCache{
		agent:  agent,
		client: &http.Client{Timeout: robotsTimeout},
		hosts:  map[string]*robotsHost{},
		now:    time.Now,
	}
}

// get returns the cached rules for a host, fetching them when stale.
func (c *robotsCache) get(ctx context.Context, u *url.URL) *robotsEntry {
	origin := u.Scheme + "://" + u.Host

	c.mu.Lock()
	host := c.hosts[origin]
	if host == nil {
		host = &robotsHost{}
		c.hosts[origin] = host
	}
	c.mu.Unlock()

	host.mu.Lock()
	defer host.mu.Unlock()
	if !host.entry.expired(c.now()) {
		return host.entry
	}

	entry := c.fetch(ctx, origin)
	// Our own cancellation is not the host's answer, and storing it would hold
	// a stopped run against the next one.
	if entry.known() || ctx.Err() == nil {
		host.entry = entry
	}
	return entry
}

func (c *robotsCache) fetch(ctx context.Context, origin string) *robotsEntry {
	unread := func(reason string, err error) *robotsEntry {
		slog.WarnContext(ctx, "robots_unread", "origin", origin,
			"reason", reason, "err", errText(err), "retry_in", robotsRetryTTL.String())
		return &robotsEntry{agent: c.agent, readAt: c.now(), ttl: robotsRetryTTL}
	}
	read := func(data *robotstxt.RobotsData) *robotsEntry {
		return &robotsEntry{
			data: data, group: data.FindGroup(c.agent),
			agent: c.agent, readAt: c.now(), ttl: robotsTTL,
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/robots.txt", nil)
	if err != nil {
		return unread("request", err)
	}
	req.Header.Set("User-Agent", c.agent)

	resp, err := c.client.Do(req)
	if err != nil {
		return unread("no_response", err)
	}
	defer resp.Body.Close()

	// RFC 9309 calls these unavailable rather than absent: the host is busy or
	// broken, and will have rules again shortly.
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return unread("http", errStatus(resp.StatusCode))
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, robotsMaxBytes))
	if err != nil {
		return unread("body", err)
	}
	// FromStatusAndBytes carries the remaining status semantics: 2xx parses and
	// 4xx allows everything.
	robots, err := robotstxt.FromStatusAndBytes(resp.StatusCode, body)
	if err != nil {
		return unread("parse", err)
	}
	return read(robots)
}
