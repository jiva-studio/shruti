package index_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/index"
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
		if got := index.NextCheck(c.unchanged, now).Sub(now); got != c.want {
			t.Errorf("after %d unchanged visits: %v, want %v", c.unchanged, got, c.want)
		}
	}
}

// A page that just changed goes back to daily, whatever it did before.
func TestChangeResetsTheInterval(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if got := index.NextCheck(0, now).Sub(now); got != 24*time.Hour {
		t.Errorf("= %v, want one day", got)
	}
}

func TestRetryIsSoonerThanARecheck(t *testing.T) {
	now := time.Date(2026, time.August, 1, 0, 0, 0, 0, time.UTC)
	if !index.RetryAt(now).Before(index.NextCheck(0, now)) {
		t.Error("a failed page must be retried sooner than an unchanged one is rechecked")
	}
}
