package handler

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/authjwt"
)

func newKeyAndVerifier(t *testing.T) (*rsa.PrivateKey, *authjwt.Verifier) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatalf("marshal pub: %v", err)
	}
	path := filepath.Join(t.TempDir(), "public.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pub}), 0o600); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	v, err := authjwt.NewVerifierFromFile(path)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return key, v
}

func signToken(t *testing.T, key *rsa.PrivateKey, kid string, claims gjwt.MapClaims) string {
	t.Helper()
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// TestCheckoutAcceptsOnlyAccessTokens: billing authenticates checkout with
// the auth service's access token (aud=chat). A refresh token (aud=auth),
// a token without aud or exp, a foreign kid and an expired token are all
// refused with 401; an accepted token reaches the plan check (400).
func TestCheckoutAcceptsOnlyAccessTokens(t *testing.T) {
	key, v := newKeyAndVerifier(t)
	otherKey, _ := newKeyAndVerifier(t)
	exp := time.Now().Add(time.Minute).Unix()
	claims := func(extra gjwt.MapClaims) gjwt.MapClaims {
		c := gjwt.MapClaims{"sub": uuid.NewString(), "anonymous": false}
		for k, val := range extra {
			c[k] = val
		}
		return c
	}

	cases := []struct {
		name string
		tok  string
		want int
	}{
		{"access aud=chat", signToken(t, key, authjwt.Kid, claims(gjwt.MapClaims{"exp": exp, "aud": "chat"})), http.StatusBadRequest},
		{"refresh aud=auth", signToken(t, key, authjwt.Kid, claims(gjwt.MapClaims{"exp": exp, "aud": "auth"})), http.StatusUnauthorized},
		{"no aud", signToken(t, key, authjwt.Kid, claims(gjwt.MapClaims{"exp": exp})), http.StatusUnauthorized},
		{"no exp", signToken(t, key, authjwt.Kid, claims(gjwt.MapClaims{"aud": "chat"})), http.StatusUnauthorized},
		{"expired", signToken(t, key, authjwt.Kid, claims(gjwt.MapClaims{"exp": time.Now().Add(-time.Minute).Unix(), "aud": "chat"})), http.StatusUnauthorized},
		{"missing kid", signToken(t, key, "", claims(gjwt.MapClaims{"exp": exp, "aud": "chat"})), http.StatusUnauthorized},
		{"foreign kid", signToken(t, key, "v2", claims(gjwt.MapClaims{"exp": exp, "aud": "chat"})), http.StatusUnauthorized},
		{"missing sub", signToken(t, key, authjwt.Kid, gjwt.MapClaims{"exp": exp, "aud": "chat", "anonymous": false}), http.StatusUnauthorized},
		{"foreign key", signToken(t, otherKey, authjwt.Kid, claims(gjwt.MapClaims{"exp": exp, "aud": "chat"})), http.StatusUnauthorized},
	}
	router := newRouteRouter(t, routeEnv{verifier: v})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := doCheckout(t, router, "Bearer "+tc.tok, `{"plan":"weekly"}`); got != tc.want {
				t.Fatalf("status %d, want %d", got, tc.want)
			}
		})
	}
}
