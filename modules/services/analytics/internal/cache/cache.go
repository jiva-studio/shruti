// Package cache is a tiny in-memory TTL cache for computed reports.
//
// The service runs as a single instance, so an in-process map is enough. It
// sits behind a minimal interface so a future multi-replica deploy can swap
// in Redis without touching the report code.
package cache

import (
	"sync"
	"time"
)

// Entry is one cached report computation.
type Entry struct {
	Result      any
	Params      map[string]any
	GeneratedAt int64 // unix ms when the underlying query ran
	exp         time.Time
}

// Cache is a concurrency-safe TTL map keyed by "report+normalized-params".
type Cache struct {
	mu    sync.Mutex
	items map[string]Entry
	now   func() time.Time // injectable for tests
}

func New() *Cache {
	return &Cache{items: make(map[string]Entry), now: time.Now}
}

// Get returns the entry for key if present and not expired.
func (c *Cache) Get(key string) (Entry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	// Valid only strictly before exp, so a zero-TTL entry (exp == set time)
	// is never served.
	if !ok || !c.now().Before(e.exp) {
		if ok {
			delete(c.items, key)
		}
		return Entry{}, false
	}
	return e, true
}

// Set stores an entry under key for ttl. A non-positive ttl disables caching
// (the entry is dropped immediately on the next Get).
func (c *Cache) Set(key string, e Entry, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e.exp = c.now().Add(ttl)
	c.items[key] = e
}
