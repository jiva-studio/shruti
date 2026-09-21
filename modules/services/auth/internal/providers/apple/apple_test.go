package apple

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
)

// fakeJWKSServer serves a single RSA-2048 key under a fixed kid.
func fakeJWKSServer(t *testing.T) (server *httptest.Server, priv *rsa.PrivateKey, kid string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	const fakeKID = "TEST_KID_1"
	doc := jwksDoc{Keys: []jwk{{
		KTY: "RSA",
		KID: fakeKID,
		Alg: "RS256",
		Use: "sig",
		N:   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		E:   base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x00, 0x01}), // 65537
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(doc)
	}))
	return srv, key, fakeKID
}

// signAppleStyle produces an RS256 JWT mimicking Apple's id-token shape.
func signAppleStyle(t *testing.T, priv *rsa.PrivateKey, kid, aud, sub string, emailVerified any, extra map[string]any) string {
	t.Helper()
	now := time.Now().Unix()
	claims := gjwt.MapClaims{
		"iss": appleIssuer,
		"aud": aud,
		"sub": sub,
		"iat": now,
		"exp": now + 600,
	}
	if emailVerified != nil {
		claims["email_verified"] = emailVerified
	}
	for k, v := range extra {
		claims[k] = v
	}
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	tok.Header["kid"] = kid
	signed, err := tok.SignedString(priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func TestAppleVerifyHappyPath(t *testing.T) {
	srv, priv, kid := fakeJWKSServer(t)
	defer srv.Close()

	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, priv, kid, "studio.jiva.shruti", "001234.deadbeef", true, map[string]any{
		"email": "user@example.com",
	})

	id, err := v.Verify(t.Context(), tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.Subject != "001234.deadbeef" {
		t.Errorf("subject = %q", id.Subject)
	}
	if id.Email != "user@example.com" {
		t.Errorf("email = %q", id.Email)
	}
	if !id.EmailVerified {
		t.Error("email_verified should be true")
	}
}

func TestAppleVerifyEmailVerifiedAsString(t *testing.T) {
	// Apple sometimes sends email_verified as the string "true" instead of bool.
	srv, priv, kid := fakeJWKSServer(t)
	defer srv.Close()

	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, priv, kid, "studio.jiva.shruti", "u1", "true", nil)
	id, err := v.Verify(t.Context(), tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !id.EmailVerified {
		t.Error("string \"true\" must coerce to true")
	}
}

func TestAppleVerifyRejectsWrongAudience(t *testing.T) {
	srv, priv, kid := fakeJWKSServer(t)
	defer srv.Close()

	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, priv, kid, "com.other.app", "u1", true, nil)
	if _, err := v.Verify(t.Context(), tok); err == nil {
		t.Error("wrong aud must reject")
	}
}

func TestAppleVerifyRejectsForeignSigner(t *testing.T) {
	srv, _, kid := fakeJWKSServer(t)
	defer srv.Close()

	// Sign with a *different* key, but use the same kid → JWKS lookup gives
	// the published key, signature won't match.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)

	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, other, kid, "studio.jiva.shruti", "u1", true, nil)
	if _, err := v.Verify(t.Context(), tok); err == nil {
		t.Error("token signed by foreign key must reject")
	}
}

func TestAppleVerifyRejectsUnknownKID(t *testing.T) {
	srv, priv, _ := fakeJWKSServer(t)
	defer srv.Close()

	v := NewVerifier([]string{"studio.jiva.shruti"})
	v.JWKSURLOverride = srv.URL

	tok := signAppleStyle(t, priv, "WHO_AM_I", "studio.jiva.shruti", "u1", true, nil)
	if _, err := v.Verify(t.Context(), tok); err == nil {
		t.Error("unknown kid must reject")
	}
}
