package index

import "time"

const (
	// DefaultRecheckMin is how soon a page that just changed is looked at again,
	// where a source does not say otherwise.
	DefaultRecheckMin = 24 * time.Hour
	// DefaultRecheckMax caps the backoff. A folder from 2008 is not going to
	// change, but "never again" would make a late correction invisible forever.
	DefaultRecheckMax = 30 * 24 * time.Hour
	// maxBackoffSteps is where doubling stops mattering, kept small so the
	// shift cannot overflow.
	maxBackoffSteps = 8
)

// NextCheck says when to look at a page again.
//
// Every visit that finds nothing new doubles the wait: one floor, two, four,
// eight… up to the ceiling. Any change resets it. So the current month's
// directory stays at the floor while a decade-old one goes quiet, and the crawl
// follows where things actually happen rather than spreading itself evenly over
// a quarter of a million files.
//
// Left alone this settles on a page's own rhythm: a listing that gains
// something weekly never gets far from the floor, because the visit that finds
// the new thing puts it back there.
//
// floor and ceiling come from the source. Zero or nonsense falls back to the
// defaults rather than producing an interval of no time at all, which would be
// a crawler asking a stranger's site for the same page as fast as it can answer.
func NextCheck(consecutiveUnchanged int, floor, ceiling time.Duration, now time.Time) time.Time {
	if floor <= 0 {
		floor = DefaultRecheckMin
	}
	if ceiling < floor {
		ceiling = DefaultRecheckMax
	}
	if ceiling < floor {
		ceiling = floor
	}
	steps := clamp(consecutiveUnchanged, 0, maxBackoffSteps)
	interval := floor << steps
	// A shift can overflow into the negative before it reaches the ceiling.
	if interval > ceiling || interval <= 0 {
		interval = ceiling
	}
	return now.Add(interval)
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// retryInterval is when to try again after the first failure. Short enough
// that a blip costs an hour.
const retryInterval = time.Hour

// RetryAt says when to retry a page that failed, backing off the same way an
// unchanging page does.
//
// A flat hourly retry, which is what this was, is fine for a blip and wrong for
// everything else: a page that has been gone since 2019 was asked for twenty
// four times a day for ever. Doubling means a real outage still recovers within
// the hour, while a dead address drifts out to about ten days — far enough
// apart to cost nothing, often enough that a page which genuinely comes back is
// still found.
//
// ceiling is the source's recheck ceiling and is a bound, not the destination:
// a source that wants its pages read at least weekly gets its failing pages
// retried at least that often too.
func RetryAt(consecutiveFailures int, ceiling time.Duration, now time.Time) time.Time {
	if ceiling <= 0 {
		ceiling = DefaultRecheckMax
	}
	steps := clamp(consecutiveFailures-1, 0, maxBackoffSteps)
	interval := retryInterval << steps
	if interval > ceiling || interval <= 0 {
		interval = ceiling
	}
	return now.Add(interval)
}
