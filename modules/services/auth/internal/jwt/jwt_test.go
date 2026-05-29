package jwt

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

// writeTempKeys writes a fresh RSA-2048 keypair under t.TempDir() and returns
// the paths.
func writeTempKeys(t *testing.T) (privPath, pubPath string) {
	t.Helper()
	dir := t.TempDir()
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
	privPath = filepath.Join(dir, "private.pem")
	pubPath = filepath.Join(dir, "public.pem")
	if err := os.WriteFile(privPath, privBytes, 0o600); err != nil {
		t.Fatalf("write priv: %v", err)
	}
	if err := os.WriteFile(pubPath, pubBytes, 0o644); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	return privPath, pubPath
}

func TestSignAndVerifyRoundtrip(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, err := NewSignerFromFile(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}

	userID := uuid.New()
	tok, jti, err := signer.Issue(IssueInput{
		UserID:    userID,
		Anonymous: true,
		Audience:  AudienceChat,
		TTL:       15 * time.Minute,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if jti == uuid.Nil {
		t.Fatal("jti should be assigned")
	}

	claims, err := verifier.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	gotUser, err := claims.UserID()
	if err != nil {
		t.Fatalf("UserID: %v", err)
	}
	if gotUser != userID {
		t.Errorf("sub mismatch: want %s, got %s", userID, gotUser)
	}
	gotJTI, err := claims.JTI()
	if err != nil {
		t.Fatalf("JTI: %v", err)
	}
	if gotJTI != jti {
		t.Errorf("jti mismatch: want %s, got %s", jti, gotJTI)
	}
	if !claims.Anonymous {
		t.Error("anonymous claim lost")
	}
}

// TestIssueStampsKidV1 — single-region collapse (#728) hardcodes every
// issued token's kid to "v1". Future rotation reintroduces a key id but
// not the multi-key map; this test pins the contract.
func TestIssueStampsKidV1(t *testing.T) {
	priv, _ := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)

	tok, _, err := signer.Issue(IssueInput{
		UserID:   uuid.New(),
		Audience: AudienceChat,
		TTL:      time.Minute,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	parsed, _, err := gjwt.NewParser().ParseUnverified(tok, &Claims{})
	if err != nil {
		t.Fatalf("parse unverified: %v", err)
	}
	kid, _ := parsed.Header["kid"].(string)
	if kid != "v1" {
		t.Errorf("kid: want v1, got %q", kid)
	}
}

func TestVerifyRejectsTamperedToken(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})
	tampered := tok[:len(tok)-2] + "XX"

	if _, err := verifier.Verify(tampered); err == nil {
		t.Error("tampered token verified")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: -time.Minute})

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("expired token verified")
	}
}

func TestVerifyRejectsForeignKey(t *testing.T) {
	priv1, _ := writeTempKeys(t)
	_, pub2 := writeTempKeys(t)

	signer, _ := NewSignerFromFile(priv1)
	verifier, _ := NewVerifierFromFile(pub2)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("foreign-key signed token verified — must reject")
	}
}

func TestIssueStampsAudienceChat(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, err := signer.Issue(IssueInput{
		UserID:   uuid.New(),
		Audience: AudienceChat,
		TTL:      time.Minute,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := verifier.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(claims.Audience) != 1 || claims.Audience[0] != AudienceChat {
		t.Errorf("aud: want [chat], got %v", claims.Audience)
	}
}

func TestIssueStampsAudienceAuthForRefresh(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(IssueInput{
		UserID:   uuid.New(),
		Audience: AudienceAuth,
		TTL:      time.Minute,
	})
	claims, _ := verifier.Verify(tok)
	if len(claims.Audience) != 1 || claims.Audience[0] != AudienceAuth {
		t.Errorf("aud: want [auth], got %v", claims.Audience)
	}
}

// TestVerifyRequiresKidV1 — symmetric with TestIssueStampsKidV1.
// Verifier rejects tokens whose kid is absent or any value other than
// "v1", even when signed by the right private key. This forecloses the
// failure mode where a token signed with kid="russia-v1" (or empty)
// could otherwise sneak through after a region rotation.
func TestVerifyRequiresKidV1(t *testing.T) {
	priv, pub := writeTempKeys(t)
	verifier, _ := NewVerifierFromFile(pub)

	// Mint tokens by hand so we can control the kid header. Use the
	// same private key NewVerifierFromFile loaded the public half of
	// so the signature path is healthy and only the kid check fires.
	privBlock, _ := pem.Decode(mustReadFile(t, priv))
	privKey, err := x509.ParsePKCS1PrivateKey(privBlock.Bytes)
	if err != nil {
		t.Fatalf("parse priv: %v", err)
	}
	mint := func(kid string) string {
		t.Helper()
		tok := gjwt.NewWithClaims(gjwt.SigningMethodRS256, gjwt.MapClaims{
			"sub": uuid.New().String(),
			"exp": time.Now().Add(time.Minute).Unix(),
		})
		if kid != "" {
			tok.Header["kid"] = kid
		}
		s, err := tok.SignedString(privKey)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return s
	}

	if _, err := verifier.Verify(mint("v1")); err != nil {
		t.Errorf("kid=v1 must verify: %v", err)
	}
	if _, err := verifier.Verify(mint("")); err == nil {
		t.Error("missing kid must be rejected")
	}
	if _, err := verifier.Verify(mint("v2")); err == nil {
		t.Error("kid=v2 must be rejected")
	}
	if _, err := verifier.Verify(mint("russia-v1")); err == nil {
		t.Error("kid=russia-v1 must be rejected")
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return b
}

func TestIssueRoundTripsIdentitiesAndRCAppUserID(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv)
	verifier, _ := NewVerifierFromFile(pub)

	ids := []ClaimIdentity{
		{Provider: "google", Subject: "gsub-1", EmailHash: "ehash-1", EmailVerified: true},
		{Provider: "apple", Subject: "asub-1"},
	}
	tok, _, _ := signer.Issue(IssueInput{
		UserID:      uuid.New(),
		Tier:        "pro",
		QuotaID:     "qid-1",
		RCAppUserID: "rc-app-1",
		Identities:  ids,
		Audience:    AudienceChat,
		TTL:         time.Minute,
	})
	claims, err := verifier.Verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.RCAppUserID != "rc-app-1" {
		t.Errorf("RCAppUserID: want rc-app-1, got %q", claims.RCAppUserID)
	}
	if len(claims.Identities) != 2 {
		t.Fatalf("identities: want 2, got %d", len(claims.Identities))
	}
	got := claims.Identities[0]
	if got.Provider != "google" || got.Subject != "gsub-1" || got.EmailHash != "ehash-1" || !got.EmailVerified {
		t.Errorf("identity[0] mismatch: %+v", got)
	}
	if claims.Identities[1].EmailHash != "" {
		t.Errorf("identity[1] EmailHash: want empty, got %q", claims.Identities[1].EmailHash)
	}
}
