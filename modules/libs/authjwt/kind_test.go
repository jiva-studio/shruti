package authjwt

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
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
		tok.Header["kid"] = Kid
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

func TestVerifyAccessRejectsRefreshTokenAsNotAccess(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)
	tok, _, err := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceAuth, TTL: time.Hour})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := verifier.VerifyAccess(tok); !errors.Is(err, ErrNotAccessToken) {
		t.Fatalf("VerifyAccess(refresh) err = %v, want ErrNotAccessToken", err)
	}
}

func TestVerifyRefreshRejectsAccessTokenAsNotRefresh(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)
	tok, _, err := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Hour})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := verifier.VerifyRefresh(tok); !errors.Is(err, ErrNotRefreshToken) {
		t.Fatalf("VerifyRefresh(access) err = %v, want ErrNotRefreshToken", err)
	}
}

// An expired refresh token is refused for its expiry, not its audience.
func TestVerifyAccessChecksExpiryBeforeAudience(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)
	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceAuth, TTL: -time.Minute})
	_, err := verifier.VerifyAccess(tok)
	if err == nil || errors.Is(err, ErrNotAccessToken) {
		t.Fatalf("VerifyAccess(expired refresh) err = %v, want an expiry error", err)
	}
}

func TestVerifyAccessRejectsEmptySubject(t *testing.T) {
	priv, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, gjwt.MapClaims{
		"aud": AudienceChat,
		"exp": time.Now().Add(time.Minute).Unix(),
	})
	tok.Header["kid"] = Kid
	s, err := tok.SignedString(mustParsePriv(t, priv))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if _, err := verifier.VerifyAccess(s); err == nil {
		t.Fatal("VerifyAccess accepted a token without sub")
	}
}

func TestWithLeewayAcceptsRecentlyExpiredToken(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	strict, _ := NewVerifierFromFile(pub)
	lenient, _ := NewVerifierFromFile(pub, WithLeeway(30*time.Second))
	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: -10 * time.Second})
	if _, err := strict.VerifyAccess(tok); err == nil {
		t.Error("strict verifier accepted an expired token")
	}
	if _, err := lenient.VerifyAccess(tok); err != nil {
		t.Errorf("30s leeway refused a token 10s past exp: %v", err)
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
