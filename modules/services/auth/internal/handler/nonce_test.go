package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

type nonceVerifier struct{ nonce string }

func (v nonceVerifier) Verify(context.Context, string) (*account.ProviderIdentity, error) {
	return &account.ProviderIdentity{Subject: "s", Nonce: v.nonce}, nil
}

// TestSigninForwardsNonce: the optional `nonce` body field reaches the
// service, which refuses a token whose nonce claim does not match (before
// any DB access, so the Service here has no pool).
func TestSigninForwardsNonce(t *testing.T) {
	signer, verifier := newTokenPair(t)
	router := NewRouter(newTestApp(t, appOptions{signer: signer, verifier: verifier, google: nonceVerifier{nonce: "right"}}).deps())

	r := httptest.NewRequest(http.MethodPost, "/auth/signin/google",
		strings.NewReader(`{"idToken":"t","nonce":"wrong"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "nonce mismatch") {
		t.Fatalf("got %d %s, want 401 nonce mismatch", w.Code, w.Body.String())
	}
}
