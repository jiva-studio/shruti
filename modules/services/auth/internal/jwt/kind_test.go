package jwt

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// TestVerifyByTokenKind pins which token each verifier accepts: access
// tokens carry aud=chat, refresh tokens aud=auth, and a refresh token
// minted without aud is still a refresh token.
func TestVerifyByTokenKind(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)
	privKey := mustParsePriv(t, priv)

	issue := func(aud string) string {
		t.Helper()
		tok, _, err := signer.Issue(IssueInput{UserID: uuid.New(), Audience: aud, TTL: time.Minute})
		if err != nil {
			t.Fatalf("issue: %v", err)
		}
		return tok
	}
	mint := func(claims gjwt.MapClaims) string {
		t.Helper()
		tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
		tok.Header["kid"] = SignerKid
		s, err := tok.SignedString(privKey)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return s
	}
	exp := time.Now().Add(time.Minute).Unix()
	cases := []struct {
		name          string
		tok           string
		access, fresh bool
	}{
		{"access aud=chat", issue(AudienceChat), true, false},
		{"refresh aud=auth", issue(AudienceAuth), false, true},
		{"refresh without aud", mint(gjwt.MapClaims{"sub": uuid.New().String(), "exp": exp, "jti": uuid.New().String()}), false, true},
		{"access without exp", mint(gjwt.MapClaims{"sub": uuid.New().String(), "aud": AudienceChat}), false, false},
		{"refresh without exp", mint(gjwt.MapClaims{"sub": uuid.New().String(), "aud": AudienceAuth}), false, false},
		{"aud contains chat", mint(gjwt.MapClaims{"sub": uuid.New().String(), "exp": exp, "aud": []string{AudienceAuth, AudienceChat}}), true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errA := verifier.VerifyAccess(tc.tok)
			if (errA == nil) != tc.access {
				t.Errorf("VerifyAccess: accepted=%v, want %v (err=%v)", errA == nil, tc.access, errA)
			}
			_, errR := verifier.VerifyRefresh(tc.tok)
			if (errR == nil) != tc.fresh {
				t.Errorf("VerifyRefresh: accepted=%v, want %v (err=%v)", errR == nil, tc.fresh, errR)
			}
		})
	}
}

func TestVerifyRefreshRejectsExpired(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)
	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceAuth, TTL: -time.Minute})
	if _, err := verifier.VerifyRefresh(tok); err == nil {
		t.Error("expired refresh token verified")
	}
}

func mustParsePriv(t *testing.T, path string) *rsa.PrivateKey {
	t.Helper()
	block, _ := pem.Decode(mustReadFile(t, path))
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("parse priv: %v", err)
	}
	return key
}
