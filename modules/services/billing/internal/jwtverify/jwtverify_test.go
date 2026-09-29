package jwtverify

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

func newKeyAndVerifier(t *testing.T) (*rsa.PrivateKey, *Verifier) {
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
	v, err := NewVerifierFromFile(path)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return key, v
}

func sign(t *testing.T, key *rsa.PrivateKey, kid string, claims gjwt.MapClaims) string {
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

// TestVerifyAcceptsOnlyAccessTokens: billing authenticates checkout with
// the auth service's access token (aud=chat). A refresh token (aud=auth),
// a token without aud or exp, a foreign kid and an expired token are all
// refused.
func TestVerifyAcceptsOnlyAccessTokens(t *testing.T) {
	key, v := newKeyAndVerifier(t)
	_, otherV := newKeyAndVerifier(t)
	sub := uuid.New().String()
	exp := time.Now().Add(time.Minute).Unix()

	cases := []struct {
		name     string
		verifier *Verifier
		tok      string
		ok       bool
	}{
		{"access aud=chat", v, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "exp": exp, "aud": "chat"}), true},
		{"refresh aud=auth", v, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "exp": exp, "aud": "auth"}), false},
		{"no aud", v, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "exp": exp}), false},
		{"no exp", v, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "aud": "chat"}), false},
		{"expired", v, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "exp": time.Now().Add(-time.Minute).Unix(), "aud": "chat"}), false},
		{"missing kid", v, sign(t, key, "", gjwt.MapClaims{"sub": sub, "exp": exp, "aud": "chat"}), false},
		{"foreign kid", v, sign(t, key, "v2", gjwt.MapClaims{"sub": sub, "exp": exp, "aud": "chat"}), false},
		{"missing sub", v, sign(t, key, SignerKid, gjwt.MapClaims{"exp": exp, "aud": "chat"}), false},
		{"foreign key", otherV, sign(t, key, SignerKid, gjwt.MapClaims{"sub": sub, "exp": exp, "aud": "chat"}), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := tc.verifier.Verify(tc.tok)
			if (err == nil) != tc.ok {
				t.Fatalf("accepted=%v, want %v (err=%v)", err == nil, tc.ok, err)
			}
			if tc.ok && claims.Subject != sub {
				t.Fatalf("sub: got %q, want %q", claims.Subject, sub)
			}
		})
	}
}
