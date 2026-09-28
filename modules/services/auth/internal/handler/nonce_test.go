package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/providers"
	"github.com/jiva-studio/shruti/auth/internal/service"
)

type nonceVerifier struct{ nonce string }

func (v nonceVerifier) Verify(context.Context, string) (*providers.Identity, error) {
	return &providers.Identity{Subject: "s", Nonce: v.nonce}, nil
}

// TestSigninForwardsNonce: the optional `nonce` body field reaches the
// service, which refuses a token whose nonce claim does not match (before
// any DB access, so the Service here has no pool).
func TestSigninForwardsNonce(t *testing.T) {
	signer, verifier := newTokenPair(t)
	svc := &service.Service{Signer: signer, Verifier: verifier, GoogleVerifier: nonceVerifier{nonce: "right"}}
	router := NewRouter(svc, verifier)

	r := httptest.NewRequest(http.MethodPost, "/auth/signin/google",
		strings.NewReader(`{"idToken":"t","nonce":"wrong"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "nonce mismatch") {
		t.Fatalf("got %d %s, want 401 nonce mismatch", w.Code, w.Body.String())
	}
}
