package service

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/providers"
	"github.com/jiva-studio/shruti/auth/internal/store"
)

// dbDSNFromEnv returns the dev/test DSN. If not set, the test skips with a
// clear message — the suite needs a real Postgres.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run service-layer integration tests")
	}
	return dsn
}

// resetSchema drops the auth schema *and* the migration bookkeeping, then
// re-applies the auth schema by reading 0001_auth_init.up.sql directly.
// Auth tests no longer go through golang-migrate — production uses the
// central `migrator` container; tests just need the schema in place.
func resetSchema(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := store.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS auth CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.schema_migrations`)

	// Load 0001_auth_init.up.sql from the workspace. Path is relative to
	// this test file: modules/services/auth/internal/service/ → up 4 →
	// repo root → infra/db/migrations/.
	sqlPath := filepath.Join("..", "..", "..", "..", "..", "infra", "db", "migrations", "0001_auth_init.up.sql")
	sqlBytes, err := os.ReadFile(sqlPath)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	if _, err := pool.Exec(context.Background(), string(sqlBytes)); err != nil {
		t.Fatalf("apply migration: %v", err)
	}
	return pool
}

// boot wires a Service with real DB + JWT + a stub provider verifier.
func boot(t *testing.T) (*Service, *stubVerifier) {
	t.Helper()
	dsn := dbDSNFromEnv(t)

	pool := resetSchema(t, dsn)
	t.Cleanup(pool.Close)

	priv, pub := tempKeys(t)
	signer, err := jwt.NewSignerFromFile(priv, "v1")
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := jwt.NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}

	stub := &stubVerifier{}
	svc := &Service{
		Pool:           pool,
		Users:          &store.UserRepo{Pool: pool},
		Identities:     &store.IdentityRepo{Pool: pool},
		RefreshTokens:  &store.RefreshTokenRepo{Pool: pool},
		Signer:         signer,
		Verifier:       verifier,
		GoogleVerifier: stub,
		AppleVerifier:  stub,
	}
	return svc, stub
}

// stubVerifier yields a preset Identity, ignoring its idToken input. Tests
// set .Want before calling SigninGoogle/Apple.
type stubVerifier struct {
	Want providers.Identity
}

func (s *stubVerifier) Verify(_ context.Context, _ string) (*providers.Identity, error) {
	cp := s.Want
	return &cp, nil
}

func tempKeys(t *testing.T) (priv, pub string) {
	t.Helper()
	dir := t.TempDir()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	privPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	pubBytes, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	pubPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PUBLIC KEY",
		Bytes: pubBytes,
	})
	priv = filepath.Join(dir, "private.pem")
	pub = filepath.Join(dir, "public.pem")
	_ = os.WriteFile(priv, privPEM, 0o600)
	_ = os.WriteFile(pub, pubPEM, 0o644)
	return
}

func TestAnonymousBootstrapIdempotent(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-1", "")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := svc.Anonymous(ctx, "dev-1", "")
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.UserID != second.UserID {
		t.Errorf("same deviceId should give same userId, got %s vs %s", first.UserID, second.UserID)
	}
	if !first.Anonymous || !second.Anonymous {
		t.Error("anonymous flag lost")
	}
}

func TestUpgradeAnonOnGoogleSignin(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	anon, err := svc.Anonymous(ctx, "dev-2", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	originalUser := anon.UserID

	stub.Want = providers.Identity{Subject: "google-sub-aaa", Email: "user@gmail.com", EmailVerified: true}
	signedIn, err := svc.SigninGoogle(ctx, SocialInput{
		IDToken:      "stub",
		DeviceID:     "dev-2",
		BearerAccess: anon.AccessToken,
	})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}
	if signedIn.UserID != originalUser {
		t.Errorf("anon userId must persist on upgrade: anon=%s, post-signin=%s", originalUser, signedIn.UserID)
	}
	if signedIn.Anonymous {
		t.Error("upgrade should mark session non-anonymous")
	}

	me, err := svc.Me(ctx, originalUser)
	if err != nil {
		t.Fatalf("me: %v", err)
	}
	if len(me.Identities) != 2 {
		t.Errorf("expected 2 identities (device + google), got %d", len(me.Identities))
	}
}

func TestExistingProviderSubBeatsAnonBearer(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	// Step 1: someone on device-A signs into Google → user X created.
	stub.Want = providers.Identity{Subject: "google-sub-xxx", Email: "u@example.com", EmailVerified: true}
	first, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub", DeviceID: "dev-A"})
	if err != nil {
		t.Fatalf("first signin: %v", err)
	}

	// Step 2: on device-B someone bootstraps anonymous → user Y.
	anonB, err := svc.Anonymous(ctx, "dev-B", "")
	if err != nil {
		t.Fatalf("anon B: %v", err)
	}
	if anonB.UserID == first.UserID {
		t.Fatal("anon-B should be a fresh user, distinct from user X")
	}

	// Step 3: on device-B same Google account signs in. Despite the anon-B
	// Bearer, the existing (google, sub) match must win — same user X.
	stub.Want = providers.Identity{Subject: "google-sub-xxx", Email: "u@example.com", EmailVerified: true}
	final, err := svc.SigninGoogle(ctx, SocialInput{
		IDToken:      "stub",
		DeviceID:     "dev-B",
		BearerAccess: anonB.AccessToken,
	})
	if err != nil {
		t.Fatalf("final signin: %v", err)
	}
	if final.UserID != first.UserID {
		t.Errorf("(provider,sub) must beat anon-Bearer: want %s, got %s", first.UserID, final.UserID)
	}
}

func TestCrossLinkVerifiedEmail(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-sub-1", Email: "shared@example.com", EmailVerified: true}
	g, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("google: %v", err)
	}

	// Apple signin (no anon Bearer) with same verified email — should link.
	stub.Want = providers.Identity{Subject: "apple-sub-1", Email: "shared@example.com", EmailVerified: true}
	a, err := svc.SigninApple(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("apple: %v", err)
	}
	if a.UserID != g.UserID {
		t.Errorf("cross-link by verified email failed: google=%s apple=%s", g.UserID, a.UserID)
	}
}

func TestNoCrossLinkOnUnverifiedEmail(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-sub-X", Email: "share@example.com", EmailVerified: true}
	g, _ := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})

	// Apple presents same email but not verified — must NOT link.
	stub.Want = providers.Identity{Subject: "apple-sub-X", Email: "share@example.com", EmailVerified: false}
	a, err := svc.SigninApple(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("apple: %v", err)
	}
	if a.UserID == g.UserID {
		t.Error("unverified email must not cross-link")
	}
}

func TestRefreshRotationAndReplay(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-R", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}

	rot, err := svc.Refresh(ctx, first.RefreshToken)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if rot.RefreshToken == first.RefreshToken {
		t.Error("refresh token should rotate")
	}

	// Replay original — should fail.
	if _, err := svc.Refresh(ctx, first.RefreshToken); err == nil {
		t.Error("replay of old refresh must be rejected")
	}
}

func TestRefreshAfterSignoutFails(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, _ := svc.Anonymous(ctx, "dev-S", "")
	if err := svc.Signout(ctx, first.RefreshToken); err != nil {
		t.Fatalf("signout: %v", err)
	}
	if _, err := svc.Refresh(ctx, first.RefreshToken); err == nil {
		t.Error("refresh after signout must be rejected")
	}
}

func TestAnonymousReturnsExistingSessionForSignedInBearer(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "g-x", Email: "x@example.com", EmailVerified: true}
	signedIn, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub", DeviceID: "dev-Z"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}

	// Bug we are guarding against: calling /auth/anonymous with the signed-in
	// Bearer must NOT create a new anon user nor demote.
	again, err := svc.Anonymous(ctx, "dev-Z", signedIn.AccessToken)
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	if again.UserID != signedIn.UserID {
		t.Errorf("must return same user: signed-in=%s, anon=%s", signedIn.UserID, again.UserID)
	}
	if again.Anonymous {
		t.Error("must not flip back to anonymous")
	}
}

// Suppress "imported and not used" if some constants drop later.
var _ = strings.Builder{}
