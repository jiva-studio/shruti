package handler

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/akdasa-studios/lectorium/billing/internal/jwtverify"
	"github.com/akdasa-studios/lectorium/billing/internal/paymento"
)

// testKeys generates an RS256 keypair, writes the public key to a temp PEM, and
// returns a verifier over it plus a token-minting closure matching the auth
// service's token shape (kid=v1, aud=chat).
func testKeys(t *testing.T) (*jwtverify.Verifier, func(sub string, anon bool) string) {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})
	path := filepath.Join(t.TempDir(), "public.pem")
	if err := os.WriteFile(path, pubPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := jwtverify.NewVerifierFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	mint := func(sub string, anon bool) string {
		claims := jwtverify.Claims{
			Anonymous: anon,
			RegisteredClaims: gjwt.RegisteredClaims{
				Subject:   sub,
				Audience:  gjwt.ClaimStrings{jwtverify.AudienceChat},
				IssuedAt:  gjwt.NewNumericDate(time.Now()),
				ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
				ID:        uuid.NewString(),
			},
		}
		tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
		tok.Header["kid"] = jwtverify.SignerKid
		signed, err := tok.SignedString(priv)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	return v, mint
}

// checkoutResp fires a checkout request and returns the status code.
func doCheckout(t *testing.T, h http.Handler, auth, body string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/billing/checkout", strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestCheckoutAuth(t *testing.T) {
	v, mint := testKeys(t)
	// Paymento unconfigured (empty key) so an authenticated, valid-plan request
	// stops at 503 before any DB call — keeps this test DB-free.
	h := &BillingHandler{
		Verifier:      v,
		Paymento:      paymento.New("", ""),
		PublicBaseURL: "https://example.test",
	}
	router := NewRouter(h)

	if got := doCheckout(t, router, "", `{"plan":"monthly"}`); got != http.StatusUnauthorized {
		t.Errorf("missing token: got %d, want 401", got)
	}
	if got := doCheckout(t, router, "Bearer garbage", `{"plan":"monthly"}`); got != http.StatusUnauthorized {
		t.Errorf("invalid token: got %d, want 401", got)
	}
	if got := doCheckout(t, router, "Bearer "+mint(uuid.NewString(), true), `{"plan":"monthly"}`); got != http.StatusForbidden {
		t.Errorf("anonymous token: got %d, want 403", got)
	}
	// Valid non-anon token, bad plan → 400 (auth passed, plan rejected).
	if got := doCheckout(t, router, "Bearer "+mint(uuid.NewString(), false), `{"plan":"weekly"}`); got != http.StatusBadRequest {
		t.Errorf("bad plan: got %d, want 400", got)
	}
	// Valid non-anon token, good plan, Paymento unconfigured → 503 (auth + plan
	// passed; the only remaining gate is the missing Paymento key).
	if got := doCheckout(t, router, "Bearer "+mint(uuid.NewString(), false), `{"plan":"yearly"}`); got != http.StatusServiceUnavailable {
		t.Errorf("valid token unconfigured paymento: got %d, want 503", got)
	}
}
