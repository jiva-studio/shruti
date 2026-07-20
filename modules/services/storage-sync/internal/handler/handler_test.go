package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// clock lets a test advance time without sleeping.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTestHealth(budget time.Duration) (*Health, *clock) {
	c := &clock{t: time.Unix(1_700_000_000, 0)}
	h := &Health{budget: budget, nowFn: c.now}
	h.lastOK = c.now()
	return h, c
}

func get(t *testing.T, h *Health, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	NewRouter(h).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return rec.Code, body
}

// Liveness must stay 200 even when the mirror is stale — a stale mirror is a
// working process with a broken dependency, and killing it would not help.
func TestHealthzIsAliveEvenWhenStale(t *testing.T) {
	h, c := newTestHealth(time.Hour)
	c.t = c.t.Add(24 * time.Hour)

	code, body := get(t, h, "/healthz")
	if code != http.StatusOK {
		t.Fatalf("healthz = %d, want 200", code)
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v, want ok", body["status"])
	}
}

// A fresh service has not completed a pass yet; it must not report stale
// immediately or every deploy would flap the alert.
func TestReadyzFreshStart(t *testing.T) {
	h, _ := newTestHealth(time.Hour)
	if code, _ := get(t, h, "/readyz"); code != http.StatusOK {
		t.Fatalf("readyz = %d, want 200 on a fresh start", code)
	}
}

// The whole point: passes failing for longer than the budget takes the service
// unready, so a prober can alert on a silently rotting mirror.
func TestReadyzGoesStaleAfterBudget(t *testing.T) {
	h, c := newTestHealth(time.Hour)

	c.t = c.t.Add(30 * time.Minute)
	h.PassFailed("yandex 403")
	if code, _ := get(t, h, "/readyz"); code != http.StatusOK {
		t.Fatalf("readyz = %d, want 200 while still inside the budget", code)
	}

	c.t = c.t.Add(45 * time.Minute) // 75 min total — past the 1h budget
	code, body := get(t, h, "/readyz")
	if code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503 once the budget lapsed", code)
	}
	if body["status"] != "stale" {
		t.Errorf("status = %v, want stale", body["status"])
	}
	if body["last_error"] != "yandex 403" {
		t.Errorf("last_error = %v, want the recorded cause", body["last_error"])
	}
}

// A success clears staleness and the recorded error.
func TestPassSucceededRecovers(t *testing.T) {
	h, c := newTestHealth(time.Hour)
	c.t = c.t.Add(2 * time.Hour)
	h.PassFailed("bunny down")
	if code, _ := get(t, h, "/readyz"); code != http.StatusServiceUnavailable {
		t.Fatalf("readyz = %d, want 503 before recovery", code)
	}

	h.PassSucceeded()
	code, body := get(t, h, "/readyz")
	if code != http.StatusOK {
		t.Fatalf("readyz = %d, want 200 after a successful pass", code)
	}
	if _, ok := body["last_error"]; ok {
		t.Errorf("last_error should be cleared, got %v", body["last_error"])
	}
	if body["status"] != "ready" {
		t.Errorf("status = %v, want ready", body["status"])
	}
}

// A failure must not extend the success clock — otherwise a service failing
// every single pass would report ready forever.
func TestPassFailedDoesNotRefreshTheClock(t *testing.T) {
	h, c := newTestHealth(30 * time.Minute)
	for range 5 {
		c.t = c.t.Add(20 * time.Minute)
		h.PassFailed("still down")
	}
	if code, _ := get(t, h, "/readyz"); code != http.StatusServiceUnavailable {
		t.Fatal("repeated failures must eventually report stale")
	}
}

// Budget 0 disables the staleness check (one-shot job mode).
func TestZeroBudgetNeverStale(t *testing.T) {
	h, c := newTestHealth(0)
	c.t = c.t.Add(999 * time.Hour)
	if code, _ := get(t, h, "/readyz"); code != http.StatusOK {
		t.Fatal("a zero budget must disable the staleness check")
	}
}
