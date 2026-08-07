// Package metrics counts what the service has done since it started.
//
// It exists because the scheduler stopped leaving runs behind. A run row had a
// beginning, an end and its counters; continuous work has none of those, and
// without something in its place the only record of an automatic crawl is log
// lines nobody is watching.
//
// Counters, not gauges, and cumulative since start: two readings a minute apart
// give a rate, and a single reading after a restart is honestly small rather
// than misleadingly zero. Nothing here is persisted — this says what this
// process has done, and a restart says so by its uptime.
package metrics

import (
	"sync"
	"sync/atomic"
	"time"
)

// Counters is safe for concurrent use and cheap enough to touch on every page.
type Counters struct {
	startedAt time.Time

	pagesFetched   atomic.Int64
	pagesUnchanged atomic.Int64
	pagesFailed    atomic.Int64
	itemsNew       atomic.Int64
	itemsChanged   atomic.Int64
	chunksIndexed  atomic.Int64
	modelCalls     atomic.Int64
	// textsEmbedded is what was actually paid a vector for, cache hits
	// excluded. The providers used here report no usage on that call, so a
	// count of texts is the honest figure and a price would be invented.
	textsEmbedded atomic.Int64
	// costNanoUSD is money in a unit an integer can hold exactly. A float
	// accumulated a hundred thousand times drifts, and this is a bill.
	costNanoUSD atomic.Int64

	mu       sync.Mutex
	failures map[string]int64
}

func New(now time.Time) *Counters {
	return &Counters{startedAt: now, failures: map[string]int64{}}
}

// Page records one visit that reached the host.
func (c *Counters) Page(unchanged bool, itemsNew, itemsChanged, chunks int) {
	if c == nil {
		return
	}
	c.pagesFetched.Add(1)
	if unchanged {
		c.pagesUnchanged.Add(1)
	}
	c.itemsNew.Add(int64(itemsNew))
	c.itemsChanged.Add(int64(itemsChanged))
	c.chunksIndexed.Add(int64(chunks))
}

// Failure records a visit that did not, under the kind the run summaries use,
// so "the site is refusing us" and "the link is dead" stay apart.
func (c *Counters) Failure(kind string) {
	if c == nil {
		return
	}
	c.pagesFailed.Add(1)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures[kind]++
}

// Spend records what a model call cost.
func (c *Counters) Spend(costUSD float64) {
	if c == nil {
		return
	}
	c.modelCalls.Add(1)
	c.costNanoUSD.Add(int64(costUSD * 1e9))
}

// Embedded records texts sent to the embedder, which is money the cost figure
// below cannot see.
func (c *Counters) Embedded(texts int) {
	if c == nil {
		return
	}
	c.textsEmbedded.Add(int64(texts))
}

// Snapshot is what the status endpoint hands over.
type Snapshot struct {
	UptimeS        int64 `json:"uptime_s"`
	PagesFetched   int64 `json:"pages_fetched"`
	PagesUnchanged int64 `json:"pages_unchanged"`
	PagesFailed    int64 `json:"pages_failed"`
	ItemsNew       int64 `json:"items_new"`
	ItemsChanged   int64 `json:"items_changed"`
	ChunksIndexed  int64 `json:"chunks_indexed"`
	ModelCalls     int64 `json:"model_calls"`
	TextsEmbedded  int64 `json:"texts_embedded"`
	// CostUSD is what the normalizer reported. Embedding is billed too and is
	// not in here: the provider states no usage for it, so TextsEmbedded is
	// what there is.
	CostUSD  float64          `json:"cost_usd"`
	Failures map[string]int64 `json:"failures"`
	// PagesPerMinute is the average over the whole of this process's life, not
	// a recent rate. It answers "is it moving at all" rather than "how fast
	// right now"; for the latter, take two readings.
	PagesPerMinute float64 `json:"pages_per_minute"`
}

func (c *Counters) Snapshot(now time.Time) Snapshot {
	if c == nil {
		return Snapshot{Failures: map[string]int64{}}
	}
	uptime := now.Sub(c.startedAt)
	if uptime <= 0 {
		uptime = time.Second
	}

	c.mu.Lock()
	failures := make(map[string]int64, len(c.failures))
	for k, v := range c.failures {
		failures[k] = v
	}
	c.mu.Unlock()

	fetched := c.pagesFetched.Load()
	return Snapshot{
		UptimeS:        int64(uptime / time.Second),
		PagesFetched:   fetched,
		PagesUnchanged: c.pagesUnchanged.Load(),
		PagesFailed:    c.pagesFailed.Load(),
		ItemsNew:       c.itemsNew.Load(),
		ItemsChanged:   c.itemsChanged.Load(),
		ChunksIndexed:  c.chunksIndexed.Load(),
		ModelCalls:     c.modelCalls.Load(),
		TextsEmbedded:  c.textsEmbedded.Load(),
		CostUSD:        float64(c.costNanoUSD.Load()) / 1e9,
		Failures:       failures,
		PagesPerMinute: float64(fetched) / uptime.Minutes(),
	}
}
