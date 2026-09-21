package index_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
)

func TestNextCheckBacksOff(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	day := 24 * time.Hour

	cases := []struct {
		unchanged int
		want      time.Duration
	}{
		{0, day},
		{1, 2 * day},
		{2, 4 * day},
		{3, 8 * day},
		{4, 16 * day},
		{5, 30 * day},
		{40, 30 * day},
		{-1, day},
	}
	for _, c := range cases {
		if got := index.NextCheck(c.unchanged, 0, 0, now).Sub(now); got != c.want {
			t.Errorf("after %d unchanged visits: %v, want %v", c.unchanged, got, c.want)
		}
	}
}

// A page that just changed goes back to daily, whatever it did before.
func TestChangeResetsTheInterval(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if got := index.NextCheck(0, 0, 0, now).Sub(now); got != 24*time.Hour {
		t.Errorf("= %v, want one day", got)
	}
}

// A source may ask to be read less often than the default, and to be given up
// on sooner than a month. Both bounds are its own.
func TestSourceBoundsReplaceTheDefaults(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	hour := time.Hour

	for _, c := range []struct {
		unchanged int
		min, max  time.Duration
		want      time.Duration
	}{
		{0, 6 * hour, 48 * hour, 6 * hour},
		{1, 6 * hour, 48 * hour, 12 * hour},
		{3, 6 * hour, 48 * hour, 48 * hour},
		{40, 6 * hour, 48 * hour, 48 * hour},
		// A week between visits, and never further apart than that.
		{9, 7 * 24 * hour, 7 * 24 * hour, 7 * 24 * hour},
	} {
		if got := index.NextCheck(c.unchanged, c.min, c.max, now).Sub(now); got != c.want {
			t.Errorf("min=%v max=%v after %d unchanged: %v, want %v",
				c.min, c.max, c.unchanged, got, c.want)
		}
	}
}

// A ceiling below the floor, or a floor of nothing, must not turn into an
// interval of no time — that is a crawler asking a stranger's site for the same
// page as fast as it can answer.
func TestNonsenseBoundsDoNotBecomeNoWait(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct{ min, max time.Duration }{
		{0, 0},
		{-time.Hour, -time.Hour},
		{time.Hour, time.Minute},
		{0, time.Minute},
	} {
		for _, unchanged := range []int{0, 3, 40} {
			if got := index.NextCheck(unchanged, c.min, c.max, now).Sub(now); got <= 0 {
				t.Errorf("min=%v max=%v after %d unchanged gave %v", c.min, c.max, unchanged, got)
			}
		}
	}
}

func TestFirstRetryIsSoonerThanARecheck(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if !index.RetryAt(1, 0, now).Before(index.NextCheck(0, 0, 0, now)) {
		t.Error("a failed page must be retried sooner than an unchanged one is rechecked")
	}
}

// A page that keeps failing is asked for less and less. Flat hourly retries
// mean an address gone since 2019 costs twenty four requests a day at somebody
// else's site, for ever, and nothing ever says so.
func TestRepeatedFailuresBackOff(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	ceiling := 30 * 24 * time.Hour

	var last time.Duration
	for fails := 1; fails <= 6; fails++ {
		got := index.RetryAt(fails, ceiling, now).Sub(now)
		if got <= last {
			t.Errorf("failure %d waits %v, no longer than the %v before it", fails, got, last)
		}
		last = got
	}
	// And it stops rather than growing without bound. Where it stops is the
	// doubling limit, well inside the source's ceiling — a page that has been
	// failing for a fortnight is still tried, just not often.
	settled := index.RetryAt(500, ceiling, now).Sub(now)
	if settled > ceiling {
		t.Errorf("after 500 failures = %v, past the ceiling %v", settled, ceiling)
	}
	if settled < 24*time.Hour || settled > 14*24*time.Hour {
		t.Errorf("settled at %v; want somewhere between a day and a fortnight", settled)
	}
}

// A source with a short ceiling keeps its failing pages on that leash too.
func TestTheRetryCeilingIsTheSourcesOwn(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	ceiling := 6 * time.Hour
	if got := index.RetryAt(9, ceiling, now).Sub(now); got != ceiling {
		t.Errorf("= %v, want %v", got, ceiling)
	}
}
