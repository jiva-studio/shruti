package fetch

import (
	"sync"
	"time"
)

// breaker is a consecutive-failure circuit breaker: after threshold failures in
// a row it opens for cooldown; any success closes it. It keeps us from
// hammering a host that is already struggling.
type breaker struct {
	mu        sync.Mutex
	threshold int
	cooldown  time.Duration
	fails     int
	openUntil time.Time
	// probing means one caller is already through the half-open door and the
	// rest wait for what it finds. Without it every worker held back by the
	// cooldown is let out at the same instant, all onto a host that has just
	// spent five minutes not answering.
	probing bool
	now     func() time.Time
}

func newBreaker(threshold int, cooldown time.Duration) *breaker {
	if threshold <= 0 {
		threshold = 5
	}
	if cooldown <= 0 {
		cooldown = 5 * time.Minute
	}
	return &breaker{threshold: threshold, cooldown: cooldown, now: time.Now}
}

func (b *breaker) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openUntil.IsZero() {
		return true
	}
	if b.now().Before(b.openUntil) {
		return false
	}
	// Cooldown elapsed — half-open: one probe goes through and the rest keep
	// waiting until it reports back.
	if b.probing {
		return false
	}
	b.probing = true
	return true
}

// record folds an outcome in and reports whether this call is what opened the
// breaker, so the moment a host is dropped can be said out loud once rather
// than inferred from a silence.
func (b *breaker) record(success bool) (justOpened bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if success {
		b.fails, b.probing = 0, false
		b.openUntil = time.Time{}
		return false
	}
	b.fails++
	// The probe failed, so the door shuts again for another cooldown rather
	// than staying ajar for everyone behind it.
	if b.probing {
		b.probing = false
		b.openUntil = b.now().Add(b.cooldown)
		return false
	}
	if b.fails >= b.threshold && b.openUntil.IsZero() {
		b.openUntil = b.now().Add(b.cooldown)
		return true
	}
	return false
}
