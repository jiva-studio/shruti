package handler

import (
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
)

// userRateLimiter caps how often a given user can hit a sensitive
// endpoint. Backing store is an in-process map[user_id]last_attempt.
//
// Why in-memory and not Redis: the only protected endpoint right now is
// /auth/account/delete, which a normal user hits at most once in the
// lifetime of an install. The cost of a sidecar instance not seeing
// another instance's recent hit is one extra Langfuse purge job — well
// below the threshold that justifies a Redis dependency on the auth
// boot path. If we ever rate-limit a hot endpoint we'll swap the backing
// store; the middleware contract stays.
//
// Concurrency: a single sync.Mutex guards the map. Delete is rare and
// the critical section is two map ops + a time compare — uncontended
// in practice. We sweep idle keys lazily on each touch to keep the map
// from growing without bound across years of uptime.
type userRateLimiter struct {
	window time.Duration
	now    func() time.Time

	mu       sync.Mutex
	attempts map[uuid.UUID]time.Time
}

func newUserRateLimiter(window time.Duration) *userRateLimiter {
	return &userRateLimiter{
		window:   window,
		now:      time.Now,
		attempts: make(map[uuid.UUID]time.Time),
	}
}

// allow records an attempt at the current time and returns (true, 0)
// if the caller is under the limit, or (false, retryAfter) if not.
// The recorded timestamp is updated only on a successful allow — a
// throttled call does NOT reset the cooldown window (otherwise a
// loop of 429s would keep extending the wait forever).
func (l *userRateLimiter) allow(userID uuid.UUID) (bool, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Opportunistic GC: drop a single expired neighbour per touch.
	// Keeps the map bounded without paying for a full sweep on every
	// request. Targets a random-ish key by iterating once.
	for k, t := range l.attempts {
		if now.Sub(t) >= l.window {
			delete(l.attempts, k)
		}
		break // one entry per call is enough.
	}

	if last, ok := l.attempts[userID]; ok {
		elapsed := now.Sub(last)
		if elapsed < l.window {
			retry := l.window - elapsed
			return false, retry
		}
	}
	l.attempts[userID] = now
	return true, 0
}

// countingLimiter caps a string key (here: client IP) to `limit` hits per
// fixed `window`. It bounds OTP-email flooding from a single source — the
// durable per-email resend cooldown lives in the DB; this only stops one IP
// from fanning out across many distinct addresses. In-process like
// userRateLimiter, and for the same reason: a sidecar missing another
// instance's recent hits at worst doubles the per-window budget, far below
// what would justify a Redis dependency on the boot path.
type countingLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu    sync.Mutex
	state map[string]*windowCount
}

type windowCount struct {
	start time.Time
	count int
}

func newCountingLimiter(limit int, window time.Duration) *countingLimiter {
	return &countingLimiter{
		limit:  limit,
		window: window,
		now:    time.Now,
		state:  make(map[string]*windowCount),
	}
}

// allow records a hit for key and reports whether it stayed under the limit.
func (l *countingLimiter) allow(key string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// Opportunistic GC: drop one expired neighbour per touch (same bounded
	// strategy as userRateLimiter).
	for k, wc := range l.state {
		if now.Sub(wc.start) >= l.window {
			delete(l.state, k)
		}
		break
	}

	wc := l.state[key]
	if wc == nil || now.Sub(wc.start) >= l.window {
		l.state[key] = &windowCount{start: now, count: 1}
		return true
	}
	if wc.count >= l.limit {
		return false
	}
	wc.count++
	return true
}

// rateLimitPerIP throttles an endpoint by client IP. Used for the public
// (unauthenticated) OTP-request endpoint, where there's no user id to key on.
func rateLimitPerIP(l *countingLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.allow(clientIP(r)) {
				w.Header().Set("Retry-After", "60")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many requests; retry later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// rateLimitPerUser is a middleware that throttles a per-user-keyed
// endpoint. It MUST be installed AFTER requireBearer so the user id is
// already on the context. A missing user is a programmer error (the
// middleware is mounted in a Bearer-guarded group) and returns 500.
func rateLimitPerUser(l *userRateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uid, ok := userFromContext(r.Context())
			if !ok {
				writeErr(w, http.StatusInternalServerError, "rate_limit_misconfigured",
					"rate limiter requires authenticated user in context")
				return
			}
			ok, retry := l.allow(uid)
			if !ok {
				// Round UP to the next whole second so the client doesn't
				// retry a few milliseconds early and immediately get 429'd
				// again. RFC 7231 says Retry-After is delta-seconds.
				secs := int(math.Ceil(retry.Seconds()))
				if secs < 1 {
					secs = 1
				}
				w.Header().Set("Retry-After", strconv.Itoa(secs))
				writeErr(w, http.StatusTooManyRequests, "rate_limited",
					"too many attempts; retry later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
