package handler

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/service"
)

// HTTP-level tests for /auth/migrate-in and /auth/migrate-revoke.
//
// The end-to-end "verify bearer → mutate DB" path lives in the
// service-layer integration tests (gated on TEST_DATABASE_URL). These
// tests focus on the cheap rejection paths — header parsing, signature
// failure, audience pinning, own-kid refusal — which are pure-Go and
// don't need a live Postgres.

// writeMigrationKeys produces a pair (signer, verifier) under a given
// kid. The handler tests construct both "this region" and "another
// region" signers so we can craft bearers signed by either side and
// confirm migrate-revoke distinguishes them.
func writeMigrationKeys(t *testing.T, dir, kid string) (*jwt.Signer, string) {
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
	privPath := filepath.Join(dir, kid+".priv.pem")
	pubPath := filepath.Join(dir, kid+".pub.pem")
	if err := os.WriteFile(privPath, privBytes, 0o600); err != nil {
		t.Fatalf("write priv: %v", err)
	}
	if err := os.WriteFile(pubPath, pubBytes, 0o644); err != nil {
		t.Fatalf("write pub: %v", err)
	}
	signer, err := jwt.NewSignerFromFile(privPath, kid)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return signer, pubPath
}

// issueBearer signs an access token with the given signer and identity
// shape. ttl=0 falls back to one minute (long enough for the test to
// finish, short enough that a leaked test bearer expires immediately).
func issueBearer(t *testing.T, s *jwt.Signer, sub uuid.UUID, audience string, ids []jwt.ClaimIdentity, ttl time.Duration) string {
	t.Helper()
	if ttl == 0 {
		ttl = time.Minute
	}
	tok, _, err := s.Issue(jwt.IssueInput{
		UserID:     sub,
		Anonymous:  false,
		Audience:   audience,
		Identities: ids,
		TTL:        ttl,
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return tok
}

func TestMigrateIn_MissingBearer(t *testing.T) {
	dir := t.TempDir()
	_, _ = writeMigrationKeys(t, dir, "v1") // populate dir for verifier
	v, err := jwt.NewVerifierFromDir(dir)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	h := &authHandler{svc: &service.Service{}, verifier: v}

	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-in", nil)
	w := httptest.NewRecorder()
	h.migrateIn(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "missing_bearer") {
		t.Errorf("code: want missing_bearer, got %s", w.Body.String())
	}
}

func TestMigrateIn_BadSignature(t *testing.T) {
	dir := t.TempDir()
	_, _ = writeMigrationKeys(t, dir, "v1")
	v, _ := jwt.NewVerifierFromDir(dir)

	h := &authHandler{svc: &service.Service{}, verifier: v}
	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-in", nil)
	r.Header.Set("Authorization", "Bearer not-a-jwt")
	w := httptest.NewRecorder()
	h.migrateIn(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "bad_bearer") {
		t.Errorf("code: want bad_bearer, got %s", w.Body.String())
	}
}

func TestMigrateIn_RefreshTokenRejected(t *testing.T) {
	// A refresh token (audience=auth) carries the user's identities just
	// like an access token does, so the cheap path of "any valid sig
	// wins" would accept it. The audience pin in migrateIn must reject
	// it explicitly — a 90-day refresh is a much wider replay surface
	// than a 15-min access.
	dir := t.TempDir()
	signer, _ := writeMigrationKeys(t, dir, "v1")
	v, _ := jwt.NewVerifierFromDir(dir)

	bearer := issueBearer(t, signer, uuid.New(), jwt.AudienceAuth, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-1"},
	}, 0)

	h := &authHandler{svc: &service.Service{}, verifier: v}
	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-in", nil)
	r.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	h.migrateIn(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "wrong_audience") {
		t.Errorf("code: want wrong_audience, got %s", w.Body.String())
	}
}

func TestMigrateRevoke_MissingBearer(t *testing.T) {
	dir := t.TempDir()
	_, _ = writeMigrationKeys(t, dir, "v1")
	v, _ := jwt.NewVerifierFromDir(dir)
	h := &authHandler{svc: &service.Service{}, verifier: v}

	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-revoke", nil)
	w := httptest.NewRecorder()
	h.migrateRevoke(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d", w.Code)
	}
}

func TestMigrateRevoke_BadSignature(t *testing.T) {
	dir := t.TempDir()
	_, _ = writeMigrationKeys(t, dir, "v1")
	v, _ := jwt.NewVerifierFromDir(dir)
	h := &authHandler{svc: &service.Service{}, verifier: v}

	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-revoke", nil)
	r.Header.Set("Authorization", "Bearer garbage")
	w := httptest.NewRecorder()
	h.migrateRevoke(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "bad_bearer") {
		t.Errorf("code: want bad_bearer, got %s", w.Body.String())
	}
}

func TestMigrateRevoke_OwnKidRefused(t *testing.T) {
	// migrate-revoke MUST refuse a bearer signed by our own kid: if we
	// signed it, no migration is in flight, the client is asking us to
	// delete a session WE just issued. The 401 own_kid prevents a
	// confused client (or a malicious one) from one-shotting a delete.
	dir := t.TempDir()
	signer, _ := writeMigrationKeys(t, dir, "v1")
	v, _ := jwt.NewVerifierFromDir(dir)

	bearer := issueBearer(t, signer, uuid.New(), jwt.AudienceChat, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-own"},
	}, 0)

	// Service.LocalKid == bearer's kid → refuse.
	h := &authHandler{
		svc:      &service.Service{LocalKid: "v1"},
		verifier: v,
	}
	r := httptest.NewRequest(http.MethodPost, "/auth/migrate-revoke", nil)
	r.Header.Set("Authorization", "Bearer "+bearer)
	w := httptest.NewRecorder()
	h.migrateRevoke(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status: want 401, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "own_kid") {
		t.Errorf("code: want own_kid, got %s", w.Body.String())
	}
}
