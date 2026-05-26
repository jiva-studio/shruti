package jwt

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	signer, err := NewSignerFromFile(priv, "v1")
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

func TestVerifyRejectsTamperedToken(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv, "v1")
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})
	tampered := tok[:len(tok)-2] + "XX"

	if _, err := verifier.Verify(tampered); err == nil {
		t.Error("tampered token verified")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv, "v1")
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: -time.Minute})

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("expired token verified")
	}
}

func TestVerifyRejectsForeignKey(t *testing.T) {
	priv1, _ := writeTempKeys(t)
	_, pub2 := writeTempKeys(t)

	signer, _ := NewSignerFromFile(priv1, "v1")
	verifier, _ := NewVerifierFromFile(pub2)

	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("foreign-key signed token verified — must reject")
	}
}

// writeKeyPairAs writes a fresh RSA keypair into `dir` under the kid's
// canonical filenames: <kid>.priv.pem and <kid>.pub.pem.
func writeKeyPairAs(t *testing.T, dir, kid string) (privPath, pubPath string) {
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
	privPath = filepath.Join(dir, kid+".priv.pem")
	pubPath = filepath.Join(dir, kid+".pub.pem")
	if err := os.WriteFile(privPath, privBytes, 0o600); err != nil {
		t.Fatalf("write priv: %v", err)
	}
	if err := os.WriteFile(pubPath, pubBytes, 0o644); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	return privPath, pubPath
}

func TestVerifierFromDirAcceptsBothKidsDuringRotation(t *testing.T) {
	dir := t.TempDir()
	priv1, _ := writeKeyPairAs(t, dir, "v1")
	priv2, _ := writeKeyPairAs(t, dir, "v2")

	verifier, err := NewVerifierFromDir(dir)
	if err != nil {
		t.Fatalf("NewVerifierFromDir: %v", err)
	}

	tok1, _, _ := func() (string, uuid.UUID, error) {
		s, _ := NewSignerFromFile(priv1, "v1")
		return s.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})
	}()
	tok2, _, _ := func() (string, uuid.UUID, error) {
		s, _ := NewSignerFromFile(priv2, "v2")
		return s.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})
	}()

	if _, err := verifier.Verify(tok1); err != nil {
		t.Errorf("v1 token must verify during rotation, got %v", err)
	}
	if _, err := verifier.Verify(tok2); err != nil {
		t.Errorf("v2 token must verify during rotation, got %v", err)
	}
}

func TestVerifierFromDirRejectsUnknownKid(t *testing.T) {
	dir := t.TempDir()
	priv1, _ := writeKeyPairAs(t, dir, "v1")
	// Sign with v1's private key but stamp a kid the verifier hasn't
	// seen — simulates a rogue signer or a missed rotation file.
	signer, _ := NewSignerFromFile(priv1, "v999")
	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})

	verifier, _ := NewVerifierFromDir(dir)
	if _, err := verifier.Verify(tok); err == nil {
		t.Error("token with unknown kid verified — must reject")
	}
}

func TestVerifierFromDirAcceptsLegacyPublicPem(t *testing.T) {
	// Status quo: only the single legacy public.pem mounted. Operator
	// hasn't created any vN.pub.pem yet. The verifier still accepts
	// the existing v1 tokens.
	dir := t.TempDir()
	priv, _ := writeTempKeys(t)
	src, _ := os.ReadFile(strings.Replace(priv, "private.pem", "public.pem", 1))
	if err := os.WriteFile(filepath.Join(dir, "public.pem"), src, 0o644); err != nil {
		t.Fatalf("write legacy public.pem: %v", err)
	}

	verifier, err := NewVerifierFromDir(dir)
	if err != nil {
		t.Fatalf("NewVerifierFromDir: %v", err)
	}
	signer, _ := NewSignerFromFile(priv, "v1")
	tok, _, _ := signer.Issue(IssueInput{UserID: uuid.New(), Audience: AudienceChat, TTL: time.Minute})
	if _, err := verifier.Verify(tok); err != nil {
		t.Errorf("legacy public.pem mapped to v1 must verify, got %v", err)
	}
}

func TestIssueStampsAudienceChat(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv, "v1")
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
	signer, _ := NewSignerFromFile(priv, "v1")
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

func TestIssueRoundTripsIdentitiesAndRCAppUserID(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv, "v1")
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
