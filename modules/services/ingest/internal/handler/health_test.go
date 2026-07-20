package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Health/readiness needs no database (the worker is stateless), so this runs in
// plain `go test ./...`.
func TestHealthz(t *testing.T) {
	r := NewRouter(RouterDeps{})

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", rec.Code)
	}
}

func TestReadyz(t *testing.T) {
	r := NewRouter(RouterDeps{})

	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("readyz status = %d, want 200", rec.Code)
	}
}
