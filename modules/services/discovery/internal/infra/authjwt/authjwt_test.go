package authjwt

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
)

func newVerifier(t *testing.T) (*Verifier, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "pub.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := NewFromFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return v, key
}

func sign(t *testing.T, key *rsa.PrivateKey, sub, aud, kid string) string {
	t.Helper()
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, &gjwt.RegisteredClaims{
		Subject:   sub,
		Audience:  gjwt.ClaimStrings{aud},
		ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestVerify_AcceptsAccessToken(t *testing.T) {
	v, key := newVerifier(t)
	sub, err := v.Verify(sign(t, key, "user-1", "chat", "v1"))
	if err != nil {
		t.Fatalf("Verify = %v, want nil", err)
	}
	if sub != "user-1" {
		t.Fatalf("sub = %q, want user-1", sub)
	}
}

// A refresh token (aud="auth", 90-day life) must not pass as a search credential.
func TestVerify_RejectsRefreshToken(t *testing.T) {
	v, key := newVerifier(t)
	if _, err := v.Verify(sign(t, key, "user-1", "auth", "v1")); err == nil {
		t.Fatal("Verify accepted a refresh token")
	}
}

func TestVerify_RejectsForeignAudience(t *testing.T) {
	v, key := newVerifier(t)
	if _, err := v.Verify(sign(t, key, "user-1", "someone-else", "v1")); err == nil {
		t.Fatal("Verify accepted a foreign audience")
	}
}

func TestVerify_RejectsWrongKid(t *testing.T) {
	v, key := newVerifier(t)
	if _, err := v.Verify(sign(t, key, "user-1", "chat", "v2")); err == nil {
		t.Fatal("Verify accepted an unexpected kid")
	}
}

func TestVerify_RejectsEmptySubject(t *testing.T) {
	v, key := newVerifier(t)
	if _, err := v.Verify(sign(t, key, "", "chat", "v1")); err == nil {
		t.Fatal("Verify accepted a subject-less token")
	}
}
