package metrics_test

import (
	"sync"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/metrics"
)

func TestCountersAddUp(t *testing.T) {
	start := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	c := metrics.New(start)

	c.Page(false, 3, 1, 40)
	c.Page(true, 0, 0, 0)
	c.Failure("gone")
	c.Failure("gone")
	c.Failure("circuit_open")
	c.Spend(0.0012)

	got := c.Snapshot(start.Add(2 * time.Minute))
	if got.PagesFetched != 2 || got.PagesUnchanged != 1 {
		t.Errorf("pages: fetched=%d unchanged=%d", got.PagesFetched, got.PagesUnchanged)
	}
	if got.ItemsNew != 3 || got.ItemsChanged != 1 || got.ChunksIndexed != 40 {
		t.Errorf("items: %+v", got)
	}
	if got.PagesFailed != 3 || got.Failures["gone"] != 2 || got.Failures["circuit_open"] != 1 {
		t.Errorf("failures: %d %v", got.PagesFailed, got.Failures)
	}
	if got.ModelCalls != 1 || got.CostUSD != 0.0012 {
		t.Errorf("model: %d calls, $%v", got.ModelCalls, got.CostUSD)
	}
	if got.PagesPerMinute != 1 {
		t.Errorf("rate = %v, want 2 pages over 2 minutes", got.PagesPerMinute)
	}
}

// Money is the reason this counts in integers. A float accumulated a hundred
// thousand times drifts, and this is a bill.
func TestSmallCostsDoNotDrift(t *testing.T) {
	start := time.Now().UTC()
	c := metrics.New(start)
	for range 100_000 {
		c.Spend(0.000001)
	}
	got := c.Snapshot(start.Add(time.Minute)).CostUSD
	if got < 0.0999 || got > 0.1001 {
		t.Errorf("a hundred thousand micro-charges came to $%v, want $0.10", got)
	}
}

// A snapshot taken in the first instant must not divide by no time at all.
func TestAnImmediateSnapshotIsFinite(t *testing.T) {
	now := time.Now().UTC()
	got := metrics.New(now).Snapshot(now)
	if got.PagesPerMinute != 0 || got.UptimeS < 0 {
		t.Errorf("%+v", got)
	}
}

// A service with no counters wired keeps working: the CLI single-URL run has
// none, and a nil must not be something every call site checks for.
func TestNilCountsNothingAndSurvives(t *testing.T) {
	var c *metrics.Counters
	c.Page(false, 1, 1, 1)
	c.Failure("gone")
	c.Spend(1)
	if got := c.Snapshot(time.Now()); got.PagesFetched != 0 || got.Failures == nil {
		t.Errorf("%+v", got)
	}
}

// Pages are counted from several workers at once, which is the only way this is
// ever used.
func TestCountingIsSafeUnderRace(t *testing.T) {
	c := metrics.New(time.Now().UTC())
	var wg sync.WaitGroup
	for range 100 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Page(false, 1, 0, 2)
			c.Failure("gone")
		}()
	}
	wg.Wait()

	got := c.Snapshot(time.Now().UTC())
	if got.PagesFetched != 100 || got.Failures["gone"] != 100 {
		t.Errorf("pages=%d failures=%v", got.PagesFetched, got.Failures)
	}
}

// The map handed out must not be the one still being written to.
func TestSnapshotDoesNotHandOutLiveState(t *testing.T) {
	c := metrics.New(time.Now().UTC())
	c.Failure("gone")

	got := c.Snapshot(time.Now().UTC())
	c.Failure("gone")
	if got.Failures["gone"] != 1 {
		t.Errorf("an earlier snapshot changed under the caller: %v", got.Failures)
	}
}
