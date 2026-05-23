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
	tok, jti, err := signer.Issue(userID, true, 15*time.Minute, uuid.Nil)
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

	tok, _, _ := signer.Issue(uuid.New(), false, time.Minute, uuid.Nil)
	tampered := tok[:len(tok)-2] + "XX"

	if _, err := verifier.Verify(tampered); err == nil {
		t.Error("tampered token verified")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	priv, pub := writeTempKeys(t)
	signer, _ := NewSignerFromFile(priv, "v1")
	verifier, _ := NewVerifierFromFile(pub)

	tok, _, _ := signer.Issue(uuid.New(), false, -time.Minute, uuid.Nil)

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("expired token verified")
	}
}

func TestVerifyRejectsForeignKey(t *testing.T) {
	priv1, _ := writeTempKeys(t)
	_, pub2 := writeTempKeys(t)

	signer, _ := NewSignerFromFile(priv1, "v1")
	verifier, _ := NewVerifierFromFile(pub2)

	tok, _, _ := signer.Issue(uuid.New(), false, time.Minute, uuid.Nil)

	if _, err := verifier.Verify(tok); err == nil {
		t.Error("foreign-key signed token verified — must reject")
	}
}
