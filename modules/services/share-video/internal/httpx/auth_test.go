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
	tok.Header["kid"] = kid
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

func TestVerifierFromDirAcceptsBothKidsDuringRotation(t *testing.T) {
	dir := t.TempDir()
	priv1 := writeKeyPair(t, dir, "v1")
	priv2 := writeKeyPair(t, dir, "v2")

	v := NewJWTVerifierFromDir(dir)
	if code := callRequireAuth(t, v, signToken(t, priv1, "v1")); code != http.StatusOK {
		t.Errorf("v1 token must verify, got %d", code)
	}
	if code := callRequireAuth(t, v, signToken(t, priv2, "v2")); code != http.StatusOK {
		t.Errorf("v2 token must verify, got %d", code)
	}
}

func TestVerifierFromDirRejectsUnknownKid(t *testing.T) {
	dir := t.TempDir()
	priv1 := writeKeyPair(t, dir, "v1")

	v := NewJWTVerifierFromDir(dir)
	if code := callRequireAuth(t, v, signToken(t, priv1, "v999")); code != http.StatusUnauthorized {
		t.Errorf("unknown kid must 401, got %d", code)
	}
}

func TestVerifierFromFileSingleKeyDeploy(t *testing.T) {
	// Back-compat: single legacy public.pem path keeps working, the
	// single key is treated as kid v1.
	dir := t.TempDir()
	priv := writeKeyPair(t, dir, "legacy")
	// Rename legacy.pub.pem -> public.pem to match the legacy layout.
	if err := os.Rename(
		filepath.Join(dir, "legacy.pub.pem"),
		filepath.Join(dir, "public.pem"),
	); err != nil {
		t.Fatalf("rename: %v", err)
	}

	v := NewJWTVerifier(filepath.Join(dir, "public.pem"))
	if code := callRequireAuth(t, v, signToken(t, priv, "v1")); code != http.StatusOK {
		t.Errorf("single-key v1 token must verify, got %d", code)
	}
}
