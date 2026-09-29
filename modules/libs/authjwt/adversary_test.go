package authjwt

import (
	"errors"
	"testing"
	"time"

	gjwt "github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// signRS256 signs claims with the test private key under kid v1.
func signRS256(t *testing.T, privPath string, claims gjwt.MapClaims) string {
	t.Helper()
	tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, claims)
	tok.Header["kid"] = Kid
	s, err := tok.SignedString(mustParsePriv(t, privPath))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// A token without `exp` never expires; neither kind may accept one, whichever
// service verifies it.
func TestVerifyRefusesTokenWithoutExpiry(t *testing.T) {
	priv, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)
	access := signRS256(t, priv, gjwt.MapClaims{"sub": uuid.NewString(), "aud": AudienceChat})
	refresh := signRS256(t, priv, gjwt.MapClaims{"sub": uuid.NewString(), "aud": AudienceAuth, "jti": uuid.NewString()})
	if _, err := verifier.VerifyAccess(access); err == nil {
		t.Error("VerifyAccess accepted a token without exp")
	}
	if _, err := verifier.VerifyRefresh(refresh); err == nil {
		t.Error("VerifyRefresh accepted a token without exp")
	}
}

// Algorithm confusion: an HS256 token keyed with the public key's PEM, and an
// unsigned alg=none token, are refused even with kid v1 and a valid aud.
func TestVerifyRefusesAlgorithmConfusion(t *testing.T) {
	_, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)
	claims := gjwt.MapClaims{
		"sub": uuid.NewString(),
		"aud": AudienceChat,
		"exp": time.Now().Add(time.Minute).Unix(),
	}

	hs := gjwt.NewWithClaims(gjwt.SigningMethodHS256, claims)
	hs.Header["kid"] = Kid
	hsTok, err := hs.SignedString(mustReadFile(t, pub))
	if err != nil {
		t.Fatalf("sign hs256: %v", err)
	}
	if _, err := verifier.VerifyAccess(hsTok); err == nil {
		t.Error("VerifyAccess accepted an HS256 token keyed with the public key")
	}

	none := gjwt.NewWithClaims(gjwt.SigningMethodNone, claims)
	none.Header["kid"] = Kid
	noneTok, err := none.SignedString(gjwt.UnsafeAllowNoneSignatureType)
	if err != nil {
		t.Fatalf("sign none: %v", err)
	}
	if _, err := verifier.VerifyAccess(noneTok); err == nil {
		t.Error("VerifyAccess accepted an alg=none token")
	}
}

// A token whose aud lists chat among others is an access token: VerifyAccess
// takes it and VerifyRefresh refuses it, so no audience list makes one token
// serve both flows.
func TestMultiAudienceTokenIsOnlyAnAccessToken(t *testing.T) {
	priv, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)
	tok := signRS256(t, priv, gjwt.MapClaims{
		"sub": uuid.NewString(),
		"aud": []string{AudienceAuth, AudienceChat},
		"exp": time.Now().Add(time.Minute).Unix(),
		"jti": uuid.NewString(),
	})
	if _, err := verifier.VerifyAccess(tok); err != nil {
		t.Errorf("VerifyAccess refused aud=[auth chat]: %v", err)
	}
	if _, err := verifier.VerifyRefresh(tok); !errors.Is(err, ErrNotRefreshToken) {
		t.Errorf("VerifyRefresh(aud=[auth chat]) err = %v, want ErrNotRefreshToken", err)
	}
}

// A token that is not valid yet is refused.
func TestVerifyRefusesNotYetValidToken(t *testing.T) {
	priv, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)
	tok := signRS256(t, priv, gjwt.MapClaims{
		"sub": uuid.NewString(),
		"aud": AudienceChat,
		"exp": time.Now().Add(time.Hour).Unix(),
		"nbf": time.Now().Add(10 * time.Minute).Unix(),
	})
	if _, err := verifier.VerifyAccess(tok); err == nil {
		t.Error("VerifyAccess accepted a token whose nbf is 10 minutes ahead")
	}
}
