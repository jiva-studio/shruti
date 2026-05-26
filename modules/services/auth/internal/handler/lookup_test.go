package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akdasa-studios/lectorium/auth/internal/service"
)

// These tests cover the input-validation paths of POST /auth/lookup,
// which fire before any service call. The OK / miss roundtrips that
// touch the DB live in service_test.go (integration).

func decodeErr(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return out
}

func TestLookupBadProvider(t *testing.T) {
	h := &authHandler{svc: &service.Service{}}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/auth/lookup",
		strings.NewReader(`{"provider":"facebook","subject":"abc"}`))
	h.lookup(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d (body=%s)", w.Code, w.Body.String())
	}
	got := decodeErr(t, w.Body.Bytes())
	if got["error"] == nil {
		t.Errorf("expected error envelope, got %v", got)
	}
}

func TestLookupBadSubject(t *testing.T) {
	cases := map[string]string{
		"empty":     "",
		"too_long":  strings.Repeat("a", 129),
		"space":     "abc def",
		"path_char": "../etc/passwd",
		"newline":   "abc\n",
	}
	for name, sub := range cases {
		t.Run(name, func(t *testing.T) {
			h := &authHandler{svc: &service.Service{}}
			body, _ := json.Marshal(map[string]string{"provider": "google", "subject": sub})
			r := httptest.NewRequest(http.MethodPost, "/auth/lookup", bytes.NewReader(body))
			w := httptest.NewRecorder()
			h.lookup(w, r)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status: want 400, got %d (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}

func TestLookupMalformedBody(t *testing.T) {
	h := &authHandler{svc: &service.Service{}}
	r := httptest.NewRequest(http.MethodPost, "/auth/lookup",
		strings.NewReader(`{not-json`))
	w := httptest.NewRecorder()
	h.lookup(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d", w.Code)
	}
}

func TestLookupValidProviders(t *testing.T) {
	// All three accepted providers pass validation. We send through
	// the validation layer and expect the request to *not* be a 400.
	// Without a real Service the call panics — we catch the panic to
	// confirm validation accepted the input.
	for _, p := range []string{"google", "apple", "device"} {
		t.Run(p, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Errorf("provider %q: expected service-layer panic (nil deps), got none", p)
				}
			}()
			h := &authHandler{svc: &service.Service{}}
			body, _ := json.Marshal(map[string]string{"provider": p, "subject": "valid-sub-1"})
			r := httptest.NewRequest(http.MethodPost, "/auth/lookup", bytes.NewReader(body))
			w := httptest.NewRecorder()
			h.lookup(w, r)
			// If validation rejected (unexpected), surface it instead of swallowing.
			if w.Code == http.StatusBadRequest {
				t.Errorf("provider %q wrongly rejected: %s", p, w.Body.String())
			}
		})
	}
}
