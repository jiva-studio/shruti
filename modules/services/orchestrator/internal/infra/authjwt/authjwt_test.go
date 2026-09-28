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

	"github.com/jiva-studio/shruti/authjwt"
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

func sign(t *testing.T, key *rsa.PrivateKey, sub, aud, tier, kid string) string {
	t.Helper()
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, &authjwt.Claims{
		Tier: tier,
		RegisteredClaims: gjwt.RegisteredClaims{
			Subject:   sub,
			Audience:  gjwt.ClaimStrings{aud},
			ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
	})
	tok.Header["kid"] = kid
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestVerifyPro_AcceptsAccessToken(t *testing.T) {
	v, key := newVerifier(t)
	sub, pro, err := v.VerifyPro(sign(t, key, "user-1", "chat", "pro", "v1"))
	if err != nil {
		t.Fatalf("VerifyPro = %v, want nil", err)
	}
	if sub != "user-1" || !pro {
		t.Fatalf("got sub=%q pro=%v, want user-1/true", sub, pro)
	}
}

// A refresh token carries aud="auth" and lives 90 days, and revoking it in the
// auth database never reaches this service. Accepting one here would turn it
// into a long-lived ingest credential.
func TestVerifyPro_RejectsRefreshToken(t *testing.T) {
	v, key := newVerifier(t)
	if _, _, err := v.VerifyPro(sign(t, key, "user-1", "auth", "pro", "v1")); err == nil {
		t.Fatal("VerifyPro accepted a refresh token")
	}
}

func TestVerifyPro_RejectsForeignAudience(t *testing.T) {
	v, key := newVerifier(t)
	if _, _, err := v.VerifyPro(sign(t, key, "user-1", "someone-else", "pro", "v1")); err == nil {
		t.Fatal("VerifyPro accepted a foreign audience")
	}
}

func TestVerifyPro_RejectsWrongKid(t *testing.T) {
	v, key := newVerifier(t)
	if _, _, err := v.VerifyPro(sign(t, key, "user-1", "chat", "pro", "v2")); err == nil {
		t.Fatal("VerifyPro accepted an unexpected kid")
	}
}

func TestVerifyPro_RejectsEmptySubject(t *testing.T) {
	v, key := newVerifier(t)
	if _, _, err := v.VerifyPro(sign(t, key, "", "chat", "pro", "v1")); err == nil {
		t.Fatal("VerifyPro accepted a subject-less token")
	}
}

func TestVerifyPro_RejectsForeignKey(t *testing.T) {
	v, _ := newVerifier(t)
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := v.VerifyPro(sign(t, other, "user-1", "chat", "pro", "v1")); err == nil {
		t.Fatal("VerifyPro accepted a token signed by another key")
	}
}

func TestVerifyPro_ReadsActiveEntitlement(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	for _, tc := range []struct {
		name      string
		tier      string
		expiresAt int64
		want      bool
	}{
		{"lifetime pro", "pro", 0, true},
		{"pro until later", "pro", now.Add(time.Hour).Unix(), true},
		{"pro lapsed", "pro", now.Add(-time.Hour).Unix(), false},
		{"free", "free", 0, false},
		{"no tier", "", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, key := newVerifier(t)
			v.now = func() time.Time { return now }
			tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, &authjwt.Claims{
				Tier:          tc.tier,
				TierExpiresAt: tc.expiresAt,
				RegisteredClaims: gjwt.RegisteredClaims{
					Subject:   "user-1",
					Audience:  gjwt.ClaimStrings{"chat"},
					ExpiresAt: gjwt.NewNumericDate(time.Now().Add(time.Hour)),
				},
			})
			tok.Header["kid"] = "v1"
			signed, err := tok.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			_, pro, err := v.VerifyPro(signed)
			if err != nil {
				t.Fatalf("VerifyPro = %v", err)
			}
			if pro != tc.want {
				t.Fatalf("pro = %v, want %v", pro, tc.want)
			}
		})
	}
}
