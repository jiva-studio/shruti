package fetch

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/temoto/robotstxt"
)

const (
	// robotsTTL is how long a fetched robots.txt is trusted.
	robotsTTL = 24 * time.Hour
	// robotsMaxBytes is the parse limit RFC 9309 asks crawlers to honour.
	robotsMaxBytes = 500 << 10
	// robotsTimeout bounds the robots.txt fetch itself.
	robotsTimeout = 10 * time.Second
)

// robotsEntry is one host's parsed robots.txt and when it was read.
type robotsEntry struct {
	data      *robotstxt.RobotsData
	group     *robotstxt.Group
	agent     string
	fetchedAt time.Time
}

func (e *robotsEntry) expired(now time.Time) bool {
	return e == nil || now.Sub(e.fetchedAt) > robotsTTL
}

// allows reports whether the path may be fetched. The blanket allow and
// blanket disallow the status code implies live on the document, not on any
// group, so the test has to go through the document.
func (e *robotsEntry) allows(path string) bool {
	if e == nil || e.data == nil {
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

// robotsCache reads and remembers robots.txt per host.
//
// A host that answers 4xx has no rules and everything is allowed. A host that
// answers 5xx, or does not answer at all, is treated as fully disallowed: an
// archive having a bad day is not permission to crawl it.
type robotsCache struct {
	agent  string
	client *http.Client

	mu      sync.Mutex
	entries map[string]*robotsEntry
	now     func() time.Time
}

func newRobotsCache(agent string) *robotsCache {
	return &robotsCache{
		agent:   agent,
		client:  &http.Client{Timeout: robotsTimeout},
		entries: map[string]*robotsEntry{},
		now:     time.Now,
	}
}

// get returns the cached rules for a host, fetching them when stale.
func (c *robotsCache) get(ctx context.Context, u *url.URL) *robotsEntry {
	key := u.Scheme + "://" + u.Host

	c.mu.Lock()
	entry := c.entries[key]
	c.mu.Unlock()
	if !entry.expired(c.now()) {
		return entry
	}

	entry = c.fetch(ctx, key)
	c.mu.Lock()
	c.entries[key] = entry
	c.mu.Unlock()
	return entry
}

func (c *robotsCache) fetch(ctx context.Context, origin string) *robotsEntry {
	entry := &robotsEntry{agent: c.agent, fetchedAt: c.now()}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/robots.txt", nil)
	if err != nil {
		return entry
	}
	req.Header.Set("User-Agent", c.agent)

	resp, err := c.client.Do(req)
	if err != nil {
		return entry
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, robotsMaxBytes))
	if err != nil {
		return entry
	}
	// FromStatusAndBytes carries the status semantics: 2xx parses, 4xx allows
	// everything, anything else disallows everything.
	robots, err := robotstxt.FromStatusAndBytes(resp.StatusCode, body)
	if err != nil {
		return entry
	}
	entry.data = robots
	entry.group = robots.FindGroup(c.agent)
	return entry
}
