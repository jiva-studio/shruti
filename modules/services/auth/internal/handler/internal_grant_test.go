package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akdasa-studios/shruti/auth/internal/jwt"
	"github.com/akdasa-studios/shruti/auth/internal/service"
)

func grantBody(t *testing.T, userID, duration string) *bytes.Buffer {
	t.Helper()
	b := &bytes.Buffer{}
	if err := json.NewEncoder(b).Encode(map[string]string{
		"userId":   userID,
		"duration": duration,
	}); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return b
}

// TestInternalGrantToken401 — a missing or wrong X-Internal-Token must
// 401 before any service call, regardless of body. (Svc is nil here; a
// 401 short-circuit means GrantAndApply is never reached.)
func TestInternalGrantToken401(t *testing.T) {
	h := &InternalGrantHandler{Token: "the-secret"}

	cases := []struct {
		name   string
		header string
		set    bool
	}{
		{"missing header", "", false},
		{"wrong token", "nope", true},
		{"empty token value", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/internal/subscription/grant",
				grantBody(t, "11111111-1111-1111-1111-111111111111", "monthly"))
			if tc.set {
				r.Header.Set("X-Internal-Token", tc.header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("want 401, got %d (body=%s)", w.Code, w.Body.String())
			}
		})
	}
}

// TestInternalGrantEmptyTokenRejects — a handler configured with an empty
// token must reject every request, even one sending an empty X-Internal-
// Token header (defence against an unset secret being matched).
func TestInternalGrantEmptyTokenRejects(t *testing.T) {
	h := &InternalGrantHandler{Token: ""}
	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/grant",
		grantBody(t, "11111111-1111-1111-1111-111111111111", "monthly"))
	r.Header.Set("X-Internal-Token", "")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("empty configured token must reject, got %d", w.Code)
	}
}

// TestInternalGrantRouteAbsentWhenDisabled — NewRouter alone (no
// AttachInternalGrant) must not expose the endpoint: chi returns 404.
// This mirrors main.go gating the route on INTERNAL_API_TOKEN.
func TestInternalGrantRouteAbsentWhenDisabled(t *testing.T) {
	priv, pub := tempKeys(t)
	signer, err := jwt.NewSignerFromFile(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := jwt.NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	svc := &service.Service{Signer: signer, Verifier: verifier}
	router := NewRouter(svc, verifier)

	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/grant",
		grantBody(t, "11111111-1111-1111-1111-111111111111", "monthly"))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("disabled route must 404, got %d (body=%s)", w.Code, w.Body.String())
	}
}

// TestInternalGrantRoutePresentWhenEnabled — once AttachInternalGrant is
// called (main.go does this when INTERNAL_API_TOKEN is set), the route
// exists. With a wrong token it 401s — not 404 — confirming the route is
// wired and reaches the handler's auth check.
func TestInternalGrantRoutePresentWhenEnabled(t *testing.T) {
	priv, pub := tempKeys(t)
	signer, _ := jwt.NewSignerFromFile(priv)
	verifier, _ := jwt.NewVerifierFromFile(pub)
	svc := &service.Service{Signer: signer, Verifier: verifier}

	router := NewRouter(svc, verifier)
	router = AttachInternalGrant(router, &InternalGrantHandler{Token: "the-secret", Svc: svc})

	r := httptest.NewRequest(http.MethodPost, "/internal/subscription/grant",
		grantBody(t, "11111111-1111-1111-1111-111111111111", "monthly"))
	r.Header.Set("X-Internal-Token", "wrong")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("enabled route with wrong token must 401 (not 404), got %d", w.Code)
	}
}
