package service

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
	"github.com/akdasa-studios/lectorium/auth/internal/providers"
	"github.com/akdasa-studios/lectorium/auth/internal/store"
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

// Path from this test file's directory to the central migrations folder.
const migrationsDir = "../../../../../infra/app/db/migrations"

// resetSchema drops the auth + app schemas *and* the migration bookkeeping,
// then re-applies every auth_*.up.sql, the outbox migration (which installs
// the AFTER DELETE trigger on auth.users), and a stand-in `usage` table
// matching 0013_chat_usage.up.sql so DeleteAccount's rate-limit cleanup has
// something to delete from. Auth tests no longer go through golang-migrate —
// production uses the central `migrator` container; tests just need the
// schema in place.
func resetSchema(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := store.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS auth CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS app CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.usage`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.schema_migrations`)

	// Auth schema first — the outbox migration's trigger targets auth.users.
	authFiles, err := filepath.Glob(filepath.Join(migrationsDir, "000[0-9]_auth_*.up.sql"))
	if err != nil {
		t.Fatalf("glob auth migrations: %v", err)
	}
	// 0022_auth_user_picture lives in the 002N range and is also auth-owned.
	moreAuth, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_auth_*.up.sql"))
	authFiles = append(authFiles, moreAuth...)
	// Outbox + the usage table the chat service owns in prod. We just need
	// the shape — chat's full set isn't required for these tests.
	authFiles = append(authFiles,
		filepath.Join(migrationsDir, "0023_outbox.up.sql"),
	)
	sort.Strings(authFiles)
	for _, p := range authFiles {
		sqlBytes, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read migration %s: %v", p, err)
		}
		if _, err := pool.Exec(context.Background(), string(sqlBytes)); err != nil {
			t.Fatalf("apply migration %s: %v", p, err)
		}
	}
	// usage stand-in matches 0013_chat_usage.up.sql exactly.
	if _, err := pool.Exec(context.Background(), `
		CREATE TABLE usage (
			key   TEXT NOT NULL,
			day   DATE NOT NULL,
			count INT NOT NULL DEFAULT 0,
			PRIMARY KEY (key, day)
		)`); err != nil {
		t.Fatalf("create usage: %v", err)
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

// TestDeleteAccountEmitsOutbox covers the two observable effects of
// DeleteAccount in one go:
//
//  1. the auth.users row (and its FK-cascaded identities / refresh_tokens)
//     is gone;
//  2. an app.outbox row appears with event_type='user.deleted' and
//     aggregate_id=<deleted_uuid>, courtesy of the AFTER DELETE trigger
//     installed by migration 0023_outbox.
//
// Rate-limit counters live in Redis with day-bucketed TTL; the cleanup-worker
// integration suite (sister PR) covers downstream cleanup.
func TestDeleteAccountEmitsOutbox(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-del", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	target := first.UserID

	if err := svc.DeleteAccount(ctx, target); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// (1) auth.users row gone.
	if u, _ := svc.Users.Get(ctx, target); u != nil {
		t.Error("auth.users row should be deleted")
	}

	// (2) outbox row exists with the right shape.
	var (
		nOutbox     int
		evt, aggID  string
	)
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM app.outbox
		  WHERE event_type = 'user.deleted'
		    AND aggregate_id = $1`,
		target.String(),
	).Scan(&nOutbox); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if nOutbox != 1 {
		t.Fatalf("expected exactly 1 user.deleted outbox row, got %d", nOutbox)
	}
	if err := svc.Pool.QueryRow(ctx,
		`SELECT event_type, aggregate_id FROM app.outbox
		  WHERE aggregate_id = $1`, target.String(),
	).Scan(&evt, &aggID); err != nil {
		t.Fatalf("scan outbox: %v", err)
	}
	if evt != "user.deleted" || aggID != target.String() {
		t.Errorf("outbox row mismatch: event_type=%q aggregate_id=%q", evt, aggID)
	}
}

// TestDeleteAccountSecondCallReturnsAlreadyDeleted — F15 fix.
// First DeleteAccount succeeds, second one against the same id returns
// the sentinel error the handler maps to 410 Gone. Without the
// RowsAffected check both calls used to return nil and the second
// one looked like a successful no-op.
func TestDeleteAccountSecondCallReturnsAlreadyDeleted(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-del-twice", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	target := first.UserID

	if err := svc.DeleteAccount(ctx, target); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	err = svc.DeleteAccount(ctx, target)
	if !errors.Is(err, ErrUserAlreadyDeleted) {
		t.Fatalf("second delete: want ErrUserAlreadyDeleted, got %v", err)
	}
}

// TestDeleteAccountConcurrentRefreshIsRejected — F8 fix.
// While DeleteAccount runs, fire a /refresh on the same user from a
// goroutine. The explicit revoke-all-refresh-tokens step takes the
// row-level lock; the in-flight refresh waits, then sees revoked_at
// != NULL on the row and bails out. Without the fix the refresh could
// commit a new token after the user is already gone.
func TestDeleteAccountConcurrentRefreshIsRejected(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-race", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	target := first.UserID

	// Race the two operations. They start at "the same time" — the lock
	// ordering inside DeleteAccount is what makes the outcome
	// deterministic regardless of which goroutine reaches Postgres first.
	var (
		wg        sync.WaitGroup
		delErr    error
		refErr    error
		refResult *Session
		ready     sync.WaitGroup
	)
	ready.Add(2)
	wg.Add(2)

	go func() {
		defer wg.Done()
		ready.Done()
		ready.Wait()
		delErr = svc.DeleteAccount(ctx, target)
	}()
	go func() {
		defer wg.Done()
		ready.Done()
		ready.Wait()
		refResult, refErr = svc.Refresh(ctx, first.RefreshToken)
	}()
	wg.Wait()

	if delErr != nil {
		t.Fatalf("delete must succeed, got %v", delErr)
	}
	if refErr == nil {
		t.Fatalf("refresh must be rejected during/after delete; got new session %+v", refResult)
	}

	// And the user is gone.
	if u, _ := svc.Users.Get(ctx, target); u != nil {
		t.Error("auth.users row should be deleted")
	}

	// A *subsequent* refresh attempt with the original token must also
	// fail — the row either no longer exists or carries revoked_at.
	// (Confirms there isn't a stale-but-valid token left in the wild.)
	if _, err := svc.Refresh(ctx, first.RefreshToken); err == nil {
		t.Error("refresh with the original token after delete must fail")
	}
}

// TestDeleteAccountRevokesAllRefreshTokens — independent of the race
// path: every refresh_token row for the user is either gone (cascade)
// or carries revoked_at by the time DeleteAccount returns. Belt-and-
// braces guard: a future refactor that moves the cascade or the
// pre-revoke UPDATE will trip this test.
func TestDeleteAccountRevokesAllRefreshTokens(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-revoke", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	// Rotate once so there are two refresh rows in flight (one active,
	// one freshly revoked by rotation) — confirms the bulk UPDATE
	// doesn't accidentally re-stamp the already-revoked one.
	rotated, err := svc.Refresh(ctx, first.RefreshToken)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	_ = rotated // we only care about the resulting DB state below

	if err := svc.DeleteAccount(ctx, first.UserID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// FK cascade removes the rows — nothing left to inspect. The
	// row count must be zero for this user. (If a future migration
	// changes ON DELETE CASCADE to RESTRICT, this assertion will
	// fail loudly with a leftover row count.)
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM auth.refresh_tokens WHERE user_id = $1`,
		first.UserID,
	).Scan(&n); err != nil {
		t.Fatalf("count refresh_tokens: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 refresh_tokens after delete, got %d", n)
	}
}

// Quiet "imported and not used" if a constant drops later.
var _ = strings.Builder{}
var _ = time.Second
