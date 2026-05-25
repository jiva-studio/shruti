package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestUserRateLimiterAllowsFirstAttempt — sanity: a fresh limiter never
// throttles the first call for any user.
func TestUserRateLimiterAllowsFirstAttempt(t *testing.T) {
	l := newUserRateLimiter(24 * time.Hour)
	ok, retry := l.allow(uuid.New())
	if !ok {
		t.Fatal("first attempt must be allowed")
	}
	if retry != 0 {
		t.Fatalf("first attempt must return retry=0, got %s", retry)
	}
}

// TestUserRateLimiterBlocksSecondAttempt — second attempt inside the
// window must be denied with a positive Retry-After.
func TestUserRateLimiterBlocksSecondAttempt(t *testing.T) {
	uid := uuid.New()
	now := time.Unix(1_700_000_000, 0)
	l := newUserRateLimiter(24 * time.Hour)
	l.now = func() time.Time { return now }

	if ok, _ := l.allow(uid); !ok {
		t.Fatal("first attempt should be allowed")
	}

	// Same instant — must be throttled, retry ≈ window.
	ok, retry := l.allow(uid)
	if ok {
		t.Fatal("second attempt in the window must be denied")
	}
	if retry <= 0 || retry > 24*time.Hour {
		t.Fatalf("retry must be in (0, window], got %s", retry)
	}

	// 1h later — still throttled.
	l.now = func() time.Time { return now.Add(time.Hour) }
	if ok, _ := l.allow(uid); ok {
		t.Fatal("second attempt 1h later must still be denied")
	}
}

// TestUserRateLimiterReleasesAfterWindow — past the window the limiter
// must let the next attempt through.
func TestUserRateLimiterReleasesAfterWindow(t *testing.T) {
	uid := uuid.New()
	now := time.Unix(1_700_000_000, 0)
	l := newUserRateLimiter(24 * time.Hour)
	l.now = func() time.Time { return now }

	if ok, _ := l.allow(uid); !ok {
		t.Fatal("first attempt should be allowed")
	}

	// Exactly one window later — second attempt allowed again.
	l.now = func() time.Time { return now.Add(24*time.Hour + time.Second) }
	if ok, _ := l.allow(uid); !ok {
		t.Fatal("attempt past the window must be allowed")
	}
}

// TestUserRateLimiterIndependentUsers — limit is per-user; one user
// hitting the cap must not affect a different user.
func TestUserRateLimiterIndependentUsers(t *testing.T) {
	l := newUserRateLimiter(24 * time.Hour)
	a, b := uuid.New(), uuid.New()

	if ok, _ := l.allow(a); !ok {
		t.Fatal("user A first call should be allowed")
	}
	if ok, _ := l.allow(a); ok {
		t.Fatal("user A second call should be denied")
	}
	// User B is a brand-new key — first call must pass.
	if ok, _ := l.allow(b); !ok {
		t.Fatal("user B first call must be allowed (different user)")
	}
}

// TestRateLimitMiddlewareReturns429WithRetryAfter exercises the full
// middleware stack: a second request inside the window gets 429 and a
// Retry-After header rounded up to whole seconds.
func TestRateLimitMiddlewareReturns429WithRetryAfter(t *testing.T) {
	uid := uuid.New()
	l := newUserRateLimiter(24 * time.Hour)

	hitCount := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hitCount++
		w.WriteHeader(http.StatusOK)
	})
	mw := rateLimitPerUser(l)(inner)

	// Helper: synthesize a request with the user id pre-stashed
	// (production gets it from requireBearer; we bypass JWT here).
	mkReq := func() *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/auth/account/delete", nil)
		ctx := context.WithValue(r.Context(), ctxKeyUserID, uid)
		return r.WithContext(ctx)
	}

	// First call passes through.
	w1 := httptest.NewRecorder()
	mw.ServeHTTP(w1, mkReq())
	if w1.Code != http.StatusOK {
		t.Fatalf("first call: want 200, got %d", w1.Code)
	}
	if hitCount != 1 {
		t.Fatalf("inner handler must run once, got %d", hitCount)
	}

	// Second call is throttled.
	w2 := httptest.NewRecorder()
	mw.ServeHTTP(w2, mkReq())
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second call: want 429, got %d", w2.Code)
	}
	if hitCount != 1 {
		t.Fatalf("inner handler must NOT run on throttled call, got hitCount=%d", hitCount)
	}
	retry := w2.Header().Get("Retry-After")
	if retry == "" {
		t.Fatal("Retry-After header missing on 429")
	}
	n, err := strconv.Atoi(retry)
	if err != nil {
		t.Fatalf("Retry-After must be integer seconds, got %q", retry)
	}
	if n < 1 {
		t.Fatalf("Retry-After must be ≥1s, got %d", n)
	}
}

// TestRateLimitMiddlewareMissingUserIs500 — the middleware presumes
// requireBearer has run; otherwise it's misconfigured at boot, and we
// fail loudly rather than silently letting anonymous traffic through.
func TestRateLimitMiddlewareMissingUserIs500(t *testing.T) {
	l := newUserRateLimiter(24 * time.Hour)
	mw := rateLimitPerUser(l)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	w := httptest.NewRecorder()
	mw.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/x", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("want 500 when user id missing, got %d", w.Code)
	}
}

// TestUserRateLimiterDoesNotResetOnDenial — a denied attempt must not
// extend the cooldown. Otherwise a tight retry loop would keep pushing
// the wait forever and the user could never recover.
func TestUserRateLimiterDoesNotResetOnDenial(t *testing.T) {
	uid := uuid.New()
	t0 := time.Unix(1_700_000_000, 0)
	l := newUserRateLimiter(10 * time.Second)
	l.now = func() time.Time { return t0 }
	if ok, _ := l.allow(uid); !ok {
		t.Fatal("first attempt must be allowed")
	}

	// Advance 5s, deny — cooldown still ends at t0+10s.
	l.now = func() time.Time { return t0.Add(5 * time.Second) }
	if ok, _ := l.allow(uid); ok {
		t.Fatal("attempt at t0+5s must be denied")
	}

	// At t0+11s the cooldown is over.
	l.now = func() time.Time { return t0.Add(11 * time.Second) }
	if ok, _ := l.allow(uid); !ok {
		t.Fatal("attempt at t0+11s must be allowed; denied call wrongly extended the window")
	}
}
