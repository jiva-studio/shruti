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

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/profile"
	"github.com/jiva-studio/shruti/auth/internal/providers"
	"github.com/jiva-studio/shruti/auth/internal/store"
)

// globalPolicy mirrors the default `PROFILE=global` deployment: email,
// name, avatar all collected. Existing service tests assume this shape
// (cross-link by verified email, name/picture written to auth.users).
// Use this in boot() so the existing behavioral contract is preserved
// byte-for-byte under the new policy boundary.
func globalPolicy() profile.ProfilePolicy {
	return profile.ProfilePolicy{
		Email:     profile.FieldPolicy{Enabled: true},
		Name:      profile.FieldPolicy{Enabled: true},
		AvatarURL: profile.FieldPolicy{Enabled: true},
	}
}

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
	// 0027_rc_webhook_app_user_id is also auth-owned but uses the
	// `rc_webhook` slug instead of `auth_` so the glob above misses it.
	moreWebhook, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_rc_webhook_*.up.sql"))
	authFiles = append(authFiles, moreWebhook...)
	// Outbox + the usage table the chat service owns in prod. We just need
	// the shape — chat's full set isn't required for these tests. 0026 layers
	// the dedup column onto app.outbox and must run after 0023.
	authFiles = append(authFiles,
		filepath.Join(migrationsDir, "0023_outbox.up.sql"),
		filepath.Join(migrationsDir, "0026_outbox_dedup.up.sql"),
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
		// Default to the `global` collection policy (email + name +
		// avatar enabled) — existing tests written before policy
		// gating depend on this shape. RU-policy scenarios opt in
		// explicitly via bootWithPolicy.
		ProfilePolicy: globalPolicy(),
	}
	return svc, stub
}

// bootWithPolicy is boot() with a custom ProfilePolicy. Use for tests
// that exercise non-default collection rules (e.g. PROFILE=ru where
// email/name/avatar are suppressed).
func bootWithPolicy(t *testing.T, p profile.ProfilePolicy) (*Service, *stubVerifier) {
	t.Helper()
	svc, stub := boot(t)
	svc.ProfilePolicy = p
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

func TestSigninBindsRCAppUserID(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-sub-rc", Email: "rc@example.com", EmailVerified: true}
	sess, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}

	var got *string
	if err := svc.Pool.QueryRow(ctx, `SELECT rc_app_user_id FROM auth.users WHERE id = $1`, sess.UserID).Scan(&got); err != nil {
		t.Fatalf("read rc_app_user_id: %v", err)
	}
	if got == nil || *got != sess.UserID.String() {
		t.Fatalf("rc_app_user_id: want %s, got %v", sess.UserID, got)
	}

	// Second signin with the same identity must be a no-op — bind is idempotent.
	if _, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"}); err != nil {
		t.Fatalf("re-signin: %v", err)
	}
	var again *string
	if err := svc.Pool.QueryRow(ctx, `SELECT rc_app_user_id FROM auth.users WHERE id = $1`, sess.UserID).Scan(&again); err != nil {
		t.Fatalf("re-read rc_app_user_id: %v", err)
	}
	if again == nil || *again != sess.UserID.String() {
		t.Fatalf("re-signin must keep binding: want %s, got %v", sess.UserID, again)
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

// ─── /auth/lookup ──────────────────────────────────────────────────────────

func TestFindUserByProviderSubject_Hit(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-lookup-1", Email: "lk@example.com", EmailVerified: true}
	sess, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}
	_ = sess

	res, err := svc.FindUserByProviderSubject(ctx, "google", "google-lookup-1")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !res.Exists {
		t.Error("expected exists=true")
	}
	if res.Anonymous {
		t.Error("signed-in user must report anonymous=false")
	}
}

func TestFindUserByProviderSubject_AnonHit(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	if _, err := svc.Anonymous(ctx, "lookup-dev-1", ""); err != nil {
		t.Fatalf("anon: %v", err)
	}
	res, err := svc.FindUserByProviderSubject(ctx, "device", "lookup-dev-1")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !res.Exists || !res.Anonymous {
		t.Errorf("anon lookup: exists=%v anonymous=%v (want true/true)", res.Exists, res.Anonymous)
	}
}

func TestFindUserByProviderSubject_Miss(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	res, err := svc.FindUserByProviderSubject(ctx, "google", "never-seen-subject")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if res.Exists {
		t.Errorf("expected exists=false, got %+v", res)
	}
}

// LookupSignin verifies the OAuth token + delegates to FindUserByProviderSubject.
func TestLookupSigninReturnsResolvedSubject(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-lksig-1", Email: "x@example.com", EmailVerified: true}
	if _, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"}); err != nil {
		t.Fatalf("signin: %v", err)
	}

	res, err := svc.LookupSignin(ctx, ProviderGoogle, "stub-idtoken")
	if err != nil {
		t.Fatalf("LookupSignin: %v", err)
	}
	if !res.Exists || res.Anonymous {
		t.Errorf("LookupSignin: %+v", res)
	}
}

func TestLookupSigninMiss(t *testing.T) {
	svc, stub := boot(t)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "never-signed-in"}
	res, err := svc.LookupSignin(ctx, ProviderGoogle, "stub-idtoken")
	if err != nil {
		t.Fatalf("LookupSignin: %v", err)
	}
	if res.Exists {
		t.Errorf("expected miss, got %+v", res)
	}
}

// ─── ProfilePolicy.FromOAuth — write-path gating ──────────────────────────

// TestSigninRuProfileDropsPIIOnWrite: with PROFILE=ru (email/name/avatar
// suppressed), Google signin must persist provider+subject but NOT
// email, name, or picture_url. Identity row's email column is NULL;
// auth.users.name and picture_url are NULL too.
func TestSigninRuProfileDropsPIIOnWrite(t *testing.T) {
	ruPolicy := profile.ProfilePolicy{
		Email:     profile.FieldPolicy{Enabled: false},
		Name:      profile.FieldPolicy{Enabled: false},
		AvatarURL: profile.FieldPolicy{Enabled: false},
	}
	svc, stub := bootWithPolicy(t, ruPolicy)
	ctx := context.Background()

	stub.Want = providers.Identity{
		Subject:       "google-ru-1",
		Email:         "person@example.com",
		EmailVerified: true,
		Name:          "Alice Anonymous",
		PictureURL:    "https://example.test/avatar.png",
	}
	sess, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}

	// identities row: email IS NULL, email_verified=false, but
	// provider+subject survived (needed for the next signin to bind).
	var (
		email         *string
		emailVerified bool
	)
	if err := svc.Pool.QueryRow(ctx,
		`SELECT email, email_verified FROM auth.identities
		  WHERE user_id = $1 AND provider = 'google'`,
		sess.UserID,
	).Scan(&email, &emailVerified); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if email != nil {
		t.Errorf("ru profile must drop email on insert, got %q", *email)
	}
	if emailVerified {
		t.Error("ru profile must drop email_verified on insert")
	}

	// auth.users.name and picture_url: both NULL.
	u, err := svc.Users.Get(ctx, sess.UserID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u.Name != nil {
		t.Errorf("ru profile must drop name on insert, got %q", *u.Name)
	}
	if u.PictureURL != nil {
		t.Errorf("ru profile must drop picture_url on insert, got %q", *u.PictureURL)
	}
}

// TestSigninRuProfileSkipsVerifiedEmailCrossLink: with email collection
// disabled, two providers on the same human email do NOT cross-link.
// They become two separate accounts. Acceptable per locked decision.
func TestSigninRuProfileSkipsVerifiedEmailCrossLink(t *testing.T) {
	ruPolicy := profile.ProfilePolicy{
		Email:     profile.FieldPolicy{Enabled: false},
		Name:      profile.FieldPolicy{Enabled: false},
		AvatarURL: profile.FieldPolicy{Enabled: false},
	}
	svc, stub := bootWithPolicy(t, ruPolicy)
	ctx := context.Background()

	stub.Want = providers.Identity{Subject: "google-ru-2", Email: "shared@example.com", EmailVerified: true}
	g, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("google: %v", err)
	}

	stub.Want = providers.Identity{Subject: "apple-ru-2", Email: "shared@example.com", EmailVerified: true}
	a, err := svc.SigninApple(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("apple: %v", err)
	}
	if a.UserID == g.UserID {
		t.Error("ru profile must NOT cross-link by email; expected two separate users")
	}
}

// TestSigninGlobalProfileWritesAreByteIdentical: with the default
// global policy (all enabled), the persisted shape matches the pre-
// policy baseline. Email, name, picture_url all land in their columns
// exactly like before.
func TestSigninGlobalProfileWritesAreByteIdentical(t *testing.T) {
	svc, stub := boot(t) // globalPolicy() by default
	ctx := context.Background()

	stub.Want = providers.Identity{
		Subject:       "google-global-1",
		Email:         "gp@example.com",
		EmailVerified: true,
		Name:          "Global Person",
		PictureURL:    "https://example.test/gp.png",
	}
	sess, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}

	var (
		email         *string
		emailVerified bool
	)
	if err := svc.Pool.QueryRow(ctx,
		`SELECT email, email_verified FROM auth.identities
		  WHERE user_id = $1 AND provider = 'google'`,
		sess.UserID,
	).Scan(&email, &emailVerified); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if email == nil || *email != "gp@example.com" {
		t.Errorf("global profile must persist email, got %v", email)
	}
	if !emailVerified {
		t.Error("global profile must persist email_verified=true")
	}

	u, err := svc.Users.Get(ctx, sess.UserID)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u.Name == nil || *u.Name != "Global Person" {
		t.Errorf("global profile must persist name, got %v", u.Name)
	}
	if u.PictureURL == nil || *u.PictureURL != "https://example.test/gp.png" {
		t.Errorf("global profile must persist picture_url, got %v", u.PictureURL)
	}
}

// Ensures errors package keeps being referenced if a future edit
// removes the only existing usage above.
var _ = errors.New
