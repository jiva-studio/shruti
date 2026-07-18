package ytdlp

import (
	"errors"
	"sync"
	"time"
)

// ErrCircuitOpen is returned by Fetch while the breaker is open — the upstream
// fetcher has failed repeatedly and is being given a cooldown.
var ErrCircuitOpen = errors.New("fetch: circuit breaker open")

// breaker is a minimal consecutive-failure circuit breaker: after `threshold`
// consecutive failures it opens for `cooldown`; any success closes it. Guards
// the pipeline against hammering a broken proxy / rate-limited extractor.
type breaker struct {
	mu        sync.Mutex
	threshold int
	cooldown  time.Duration
	fails     int
	openUntil time.Time
	now       func() time.Time
}

func newBreaker(threshold int, cooldown time.Duration) *breaker {
	if threshold <= 0 {
		threshold = 5
	}
	if cooldown <= 0 {
		cooldown = 30 * time.Second
	}
	return &breaker{threshold: threshold, cooldown: cooldown, now: time.Now}
}

// allow reports whether a call may proceed.
func (b *breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openUntil.IsZero() {
		return true
	}
	if b.now().Before(b.openUntil) {
		return false
	}
	// cooldown elapsed — half-open: allow one probe and reset the window.
	b.openUntil = time.Time{}
	b.fails = 0
	return true
}

// record folds a call outcome into the breaker state.
func (b *breaker) record(success bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if success {
		b.fails = 0
		b.openUntil = time.Time{}
		return
	}
	b.fails++
	if b.fails >= b.threshold {
		b.openUntil = b.now().Add(b.cooldown)
	}
}
