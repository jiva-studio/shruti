package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Health/readiness needs no database, so this runs in plain `go test ./...`.
func TestHealthz(t *testing.T) {
	r := NewRouter(RouterDeps{Pool: nil})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", rec.Code)
	}
}

// readyz with no pool must report not-ready (503) rather than panic — the edge
// gates traffic on this until the DB pool + migrations are in place.
func TestReadyzWithoutPool(t *testing.T) {
	r := NewRouter(RouterDeps{Pool: nil})

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503", rec.Code)
	}
}
