package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/analytics/internal/cache"

	// Register the built-in reports so listening_daily is dispatchable.
	_ "github.com/jiva-studio/lectorium/analytics/internal/reports"
)

// newTestRouter builds the router with a nil pool. That's safe for the cases
// below: the report validates its params BEFORE it ever touches the DB, so
// invalid input and unknown-report paths never dereference the pool.
func newTestRouter() http.Handler {
	return NewRouter(RouterDeps{Pool: nil, Cache: cache.New(), DefaultTTL: 60 * time.Second})
}

func doGet(t *testing.T, h http.Handler, path string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json for %s: %v (body=%s)", path, err, rec.Body.String())
	}
	return rec.Code, body
}

func TestHealthz(t *testing.T) {
	code, body := doGet(t, newTestRouter(), "/healthz")
	if code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("healthz: code=%d body=%+v", code, body)
	}
}

func TestUnknownReport(t *testing.T) {
	code, body := doGet(t, newTestRouter(), "/analytics/reports/nope")
	if code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", code)
	}
	if body["ok"] != false {
		t.Fatalf("expected ok=false, got %+v", body)
	}
	errObj, _ := body["error"].(map[string]any)
	if errObj["code"] != "unknown_report" {
		t.Fatalf("expected unknown_report, got %+v", body["error"])
	}
}

func TestListeningDailyMissingParams(t *testing.T) {
	code, body := doGet(t, newTestRouter(), "/analytics/reports/listening_daily")
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%+v", code, body)
	}
	errObj, _ := body["error"].(map[string]any)
	if errObj["code"] != "invalid_params" {
		t.Fatalf("expected invalid_params, got %+v", body["error"])
	}
}

func TestListeningDailyBadDate(t *testing.T) {
	code, body := doGet(t, newTestRouter(), "/analytics/reports/listening_daily?from=2026-13-99&to=2026-07-10")
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%+v", code, body)
	}
}

func TestListeningDailyInvertedRange(t *testing.T) {
	code, _ := doGet(t, newTestRouter(), "/analytics/reports/listening_daily?from=2026-07-10&to=2026-07-01")
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400 for to<from, got %d", code)
	}
}
