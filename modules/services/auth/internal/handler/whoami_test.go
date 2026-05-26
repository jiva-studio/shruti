package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// MVP /whoami returns an empty country unconditionally — see whoami.go
// for the GeoIP TODO. This test pins the contract so a future change
// can't silently start leaking real IPs into the response body.
func TestWhoamiReturnsEmptyCountry(t *testing.T) {
	h := &authHandler{}
	r := httptest.NewRequest(http.MethodGet, "/whoami", nil)
	r.Header.Set("X-Forwarded-For", "8.8.8.8")
	w := httptest.NewRecorder()
	h.whoami(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got, ok := body["country"]; !ok {
		t.Errorf("missing country field: %v", body)
	} else if got != "" {
		t.Errorf("country: want empty (MVP), got %q", got)
	}
}

func TestWhoamiNoBearerRequired(t *testing.T) {
	// Public endpoint — no Authorization header is set, must still 200.
	h := &authHandler{}
	r := httptest.NewRequest(http.MethodGet, "/whoami", nil)
	w := httptest.NewRecorder()
	h.whoami(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", w.Code)
	}
}
