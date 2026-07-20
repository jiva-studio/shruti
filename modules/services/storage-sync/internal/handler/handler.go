// Package handler exposes storage-sync's health surface. The service is
// broker- and timer-driven, so HTTP exists purely so an external prober can
// answer "is the mirror still being maintained?".
//
// The distinction that matters: liveness is NOT the same as working. A wedged
// full pass — Bunny 403ing after a key rotation, Yandex refusing writes — leaves
// the process perfectly alive while the mirror silently rots, which is exactly
// the failure the RU fast path was built to avoid. So /healthz reports the
// process, and /readyz reports the WORK: it fails once the last successful pass
// is older than a staleness budget, giving blackbox something real to alert on.
package handler

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"
)

// buildSHA / buildTime — populated by the image build (Dockerfile ARGs -> ENVs).
var (
	buildSHA  = os.Getenv("LECTORIUM_BUILD_SHA")
	buildTime = os.Getenv("LECTORIUM_BUILD_TIME")
)

// Health tracks pass outcomes so readiness can reflect real mirroring progress.
// Safe for concurrent use: the pass loop writes, the prober reads.
type Health struct {
	mu       sync.RWMutex
	lastOK   time.Time
	lastErr  string
	budget   time.Duration
	nowFn    func() time.Time // injectable for tests
	passes   int
	failures int
}

// NewHealth builds a tracker whose readiness tolerates `budget` without a
// successful pass. Start the clock at construction so a service that has not
// finished its first pass yet is not instantly reported stale.
func NewHealth(budget time.Duration) *Health {
	h := &Health{budget: budget, nowFn: time.Now}
	h.lastOK = h.nowFn()
	return h
}

// PassSucceeded records a completed reconciling pass.
func (h *Health) PassSucceeded() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastOK = h.nowFn()
	h.lastErr = ""
	h.passes++
}

// PassFailed records a failed pass. It deliberately does NOT move lastOK: a
// service failing every pass must go unready once the budget lapses.
func (h *Health) PassFailed(err string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastErr = err
	h.failures++
}

// stale reports whether the last successful pass is older than the budget.
func (h *Health) stale() (bool, time.Duration) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	age := h.nowFn().Sub(h.lastOK)
	return h.budget > 0 && age > h.budget, age
}

// NewRouter wires:
//
//	GET /healthz   (liveness — the process is up)
//	GET /readyz    (readiness — a pass succeeded within the staleness budget)
func NewRouter(h *Health) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"build":  map[string]string{"sha": buildSHA, "time": buildTime},
		})
	})

	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		stale, age := h.stale()
		h.mu.RLock()
		body := map[string]any{
			"last_success_age_seconds": int(age.Seconds()),
			"passes":                   h.passes,
			"failures":                 h.failures,
		}
		if h.lastErr != "" {
			body["last_error"] = h.lastErr
		}
		h.mu.RUnlock()

		if stale {
			body["status"] = "stale"
			writeJSON(w, http.StatusServiceUnavailable, body)
			return
		}
		body["status"] = "ready"
		writeJSON(w, http.StatusOK, body)
	})

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
