package index

import "time"

const (
	// baseInterval is how soon a page that just changed is looked at again.
	baseInterval = 24 * time.Hour
	// maxInterval caps the backoff. A folder from 2008 is not going to change,
	// but "never again" would make a late correction invisible forever.
	maxInterval = 30 * 24 * time.Hour
	// maxBackoffSteps is where doubling stops mattering, kept small so the
	// shift cannot overflow.
	maxBackoffSteps = 8
)

// NextCheck says when to look at a page again.
//
// Every visit that finds nothing new doubles the wait: 1 day, 2, 4, 8… capped
// at a month. Any change resets it. So the current month's directory stays
// daily while a decade-old one goes quiet, and the crawl budget follows where
// things actually happen rather than being spread evenly over a quarter of a
// million files.
func NextCheck(consecutiveUnchanged int, now time.Time) time.Time {
	steps := min(max(consecutiveUnchanged, 0), maxBackoffSteps)
	interval := baseInterval << steps
	if interval > maxInterval {
		interval = maxInterval
	}
	return now.Add(interval)
}

// retryInterval is when to try again after a page failed to fetch. Short
// enough that a blip costs an hour, long enough that a dead URL is not
// hammered.
const retryInterval = time.Hour

// RetryAt says when to retry a page that failed.
func RetryAt(now time.Time) time.Time { return now.Add(retryInterval) }
