package httpx

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// writeKeyPair drops a fresh RSA-2048 pair under `dir/<kid>.priv.pem`
// + `<kid>.pub.pem` and returns the parsed private key for signing.
func writeKeyPair(t *testing.T, dir, kid string) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	privBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	pub, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	pubBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pub,
	})
	if err := os.WriteFile(filepath.Join(dir, kid+".priv.pem"), privBytes, 0o600); err != nil {
		t.Fatalf("write priv: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, kid+".pub.pem"), pubBytes, 0o644); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	return key
}

func signToken(t *testing.T, priv *rsa.PrivateKey, kid string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub":       "user-1",
		"anonymous": false,
		"exp":       time.Now().Add(time.Minute).Unix(),
	})
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// callRequireAuth fires a request through the middleware and returns
// the status code emitted to the test client. Handler-side success is
// represented by a 200 (the inner handler always writes 200 on entry).
func callRequireAuth(t *testing.T, v *JWTVerifier, bearer string) int {
	t.Helper()
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	v.RequireAuth(inner).ServeHTTP(rec, req)
	return rec.Code
}

// writeSinglePublicKey writes a fresh keypair and returns the private
// key plus the path to the corresponding `public.pem` (the file the
// single-key verifier expects).
func writeSinglePublicKey(t *testing.T) (*rsa.PrivateKey, string) {
	t.Helper()
	dir := t.TempDir()
	priv := writeKeyPair(t, dir, "legacy")
	pubPath := filepath.Join(dir, "public.pem")
	if err := os.Rename(filepath.Join(dir, "legacy.pub.pem"), pubPath); err != nil {
		t.Fatalf("rename: %v", err)
	}
	return priv, pubPath
}

func TestVerifierAcceptsKidV1(t *testing.T) {
	priv, pubPath := writeSinglePublicKey(t)
	v := NewJWTVerifier(pubPath)
	if code := callRequireAuth(t, v, signToken(t, priv, "v1")); code != http.StatusOK {
		t.Errorf("kid=v1 must verify, got %d", code)
	}
}

// Pins the #728 single-region collapse contract: only kid="v1" is
// accepted. A token with any other (or absent) kid header — even one
// signed by the current private key — must be rejected. Catches the
// failure mode where a stale `<other-kid>.pub.pem` is left on disk and
// share-video happily verifies anything signed against it.
func TestVerifierRejectsMissingKid(t *testing.T) {
	priv, pubPath := writeSinglePublicKey(t)
	v := NewJWTVerifier(pubPath)
	if code := callRequireAuth(t, v, signToken(t, priv, "")); code != http.StatusUnauthorized {
		t.Errorf("missing kid must 401, got %d", code)
	}
}

func TestVerifierRejectsForeignKid(t *testing.T) {
	priv, pubPath := writeSinglePublicKey(t)
	v := NewJWTVerifier(pubPath)
	if code := callRequireAuth(t, v, signToken(t, priv, "v2")); code != http.StatusUnauthorized {
		t.Errorf("kid=v2 must 401, got %d", code)
	}
	if code := callRequireAuth(t, v, signToken(t, priv, "russia-v1")); code != http.StatusUnauthorized {
		t.Errorf("kid=russia-v1 must 401, got %d", code)
	}
}
