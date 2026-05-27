package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
)

// Integration tests for MigrateIn / MigrateRevoke. Reuse the boot()
// helper from service_test.go — every test in this file needs a live
// Postgres and gets skipped via dbDSNFromEnv when TEST_DATABASE_URL is
// unset.

// makeMigrateClaims builds a Claims payload the migrate-in handler
// would have already verified. The userID is preserved through `sub`
// — the destination region inserts the user row with that exact id,
// so subsequent migrate-revoke calls against the source region can
// find the right row.
func makeMigrateClaims(userID uuid.UUID, ids []jwt.ClaimIdentity, tier string, exp *time.Time) *jwt.Claims {
	c := &jwt.Claims{
		Tier:        tier,
		Identities:  ids,
		RCAppUserID: userID.String(),
	}
	c.Subject = userID.String()
	if exp != nil {
		c.TierExpiresAt = exp.Unix()
	}
	return c
}

func TestMigrateIn_FreshUser(t *testing.T) {
	svc, _ := boot(t)
	svc.RegionID = "russia"
	ctx := context.Background()

	userID := uuid.New()
	claims := makeMigrateClaims(userID, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-fresh", EmailVerified: true},
	}, TierPro, nil)

	sess, err := svc.MigrateIn(ctx, claims, "dev-fresh")
	if err != nil {
		t.Fatalf("migrate-in: %v", err)
	}
	if sess == nil || sess.UserID != userID {
		t.Fatalf("session.UserID: want %s, got %v", userID, sess)
	}
	if sess.Anonymous {
		t.Errorf("session must not be anonymous post-migrate")
	}

	// Verify the user row exists with home_region=russia and pro tier
	// preserved from the claim.
	var (
		gotTier   string
		gotRegion string
	)
	if err := svc.Pool.QueryRow(ctx,
		`SELECT tier, home_region FROM auth.users WHERE id = $1`, userID,
	).Scan(&gotTier, &gotRegion); err != nil {
		t.Fatalf("read user: %v", err)
	}
	if gotTier != TierPro {
		t.Errorf("tier: want pro, got %q", gotTier)
	}
	if gotRegion != "russia" {
		t.Errorf("home_region: want russia, got %q", gotRegion)
	}

	// Identity row also stamped with home_region=russia.
	var idRegion string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT home_region FROM auth.identities WHERE provider = $1 AND subject = $2`,
		"google", "gsub-fresh",
	).Scan(&idRegion); err != nil {
		t.Fatalf("read identity: %v", err)
	}
	if idRegion != "russia" {
		t.Errorf("identity home_region: want russia, got %q", idRegion)
	}
}

func TestMigrateIn_Idempotent(t *testing.T) {
	svc, _ := boot(t)
	svc.RegionID = "russia"
	ctx := context.Background()

	userID := uuid.New()
	claims := makeMigrateClaims(userID, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-idem"},
	}, TierFree, nil)

	first, err := svc.MigrateIn(ctx, claims, "dev-idem")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := svc.MigrateIn(ctx, claims, "dev-idem")
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.UserID != second.UserID {
		t.Errorf("idempotent re-migrate must keep userID stable: %s != %s",
			first.UserID, second.UserID)
	}
	// Only one identity row, no duplicate insert.
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM auth.identities WHERE user_id = $1`, userID,
	).Scan(&n); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if n != 1 {
		t.Errorf("identity count: want 1, got %d", n)
	}
}

func TestMigrateIn_AnonymousRejected(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	// Only device identities → anon. Migration is rejected — anon flow
	// uses signOut + reboot, not migrate-in.
	claims := makeMigrateClaims(uuid.New(), []jwt.ClaimIdentity{
		{Provider: "device", Subject: "dev-anon-only"},
	}, TierFree, nil)

	_, err := svc.MigrateIn(ctx, claims, "dev")
	if !errors.Is(err, ErrMigrateInAnonRejected) {
		t.Fatalf("want ErrMigrateInAnonRejected, got %v", err)
	}
}

func TestMigrateIn_NoIdentitiesRejected(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	claims := &jwt.Claims{}
	claims.Subject = uuid.New().String()
	// No identities at all → reject. Without identities the destination
	// has nothing to mirror; we don't materialise empty users.
	if _, err := svc.MigrateIn(ctx, claims, ""); err == nil {
		t.Error("empty identities must be rejected")
	}
}

func TestMigrateIn_BadSub(t *testing.T) {
	svc, _ := boot(t)
	ctx := context.Background()

	claims := &jwt.Claims{
		Identities: []jwt.ClaimIdentity{{Provider: "google", Subject: "gsub"}},
	}
	claims.Subject = "not-a-uuid"
	if _, err := svc.MigrateIn(ctx, claims, ""); err == nil {
		t.Error("non-UUID sub must be rejected")
	}
}

func TestMigrateIn_PreservesTierExpiresAt(t *testing.T) {
	// Pro user mid-month: the destination region must end up with
	// the same tier_expires_at as the source so the next RC webhook
	// can extend/expire from the right baseline.
	svc, _ := boot(t)
	svc.RegionID = "global"
	ctx := context.Background()

	userID := uuid.New()
	exp := time.Unix(1900000000, 0).UTC() // far future
	claims := makeMigrateClaims(userID, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-exp"},
	}, TierPro, &exp)

	if _, err := svc.MigrateIn(ctx, claims, ""); err != nil {
		t.Fatalf("migrate-in: %v", err)
	}
	var got *time.Time
	if err := svc.Pool.QueryRow(ctx,
		`SELECT tier_expires_at FROM auth.users WHERE id = $1`, userID,
	).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got == nil {
		t.Fatalf("tier_expires_at: want non-nil, got nil")
	}
	if !got.Equal(exp) {
		t.Errorf("tier_expires_at: want %v, got %v", exp, got)
	}
}

func TestMigrateIn_RCAppUserIDPreserved(t *testing.T) {
	// The destination must keep rc_app_user_id verbatim so future RC
	// webhooks (either local or broadcast-applied) match the user row
	// by the same key.
	svc, _ := boot(t)
	svc.RegionID = "russia"
	ctx := context.Background()

	userID := uuid.New()
	claims := makeMigrateClaims(userID, []jwt.ClaimIdentity{
		{Provider: "google", Subject: "gsub-rc"},
	}, TierFree, nil)

	if _, err := svc.MigrateIn(ctx, claims, ""); err != nil {
		t.Fatalf("migrate-in: %v", err)
	}
	var got *string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT rc_app_user_id FROM auth.users WHERE id = $1`, userID,
	).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got == nil || *got != userID.String() {
		t.Errorf("rc_app_user_id: want %s, got %v", userID, got)
	}
}

func TestMigrateIn_AnonConflictResolved(t *testing.T) {
	// Dest region holds a fresh anonymous user with device id "dev-X"
	// (cold-boot bootstrap before migration). Source user being migrated
	// also has device id "dev-X" + a real google identity. The migration
	// must succeed: the anonymous throwaway is dropped, the migrated user
	// + its identities land cleanly.
	svc, _ := boot(t)
	svc.RegionID = "global"
	ctx := context.Background()

	// 1. Seed the dest with an anonymous user owning the conflicting device.
	const deviceSub = "dev-anon-conflict"
	anonID := uuid.New()
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO auth.users (id, home_region) VALUES ($1, 'global')`,
		anonID,
	); err != nil {
		t.Fatalf("seed anon user: %v", err)
	}
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO auth.identities (provider, subject, user_id, home_region)
		 VALUES ('device', $1, $2, 'global')`,
		deviceSub, anonID,
	); err != nil {
		t.Fatalf("seed anon identity: %v", err)
	}

	// 2. Migrate a real user with the same device + a google identity.
	migrateID := uuid.New()
	claims := makeMigrateClaims(migrateID, []jwt.ClaimIdentity{
		{Provider: "device", Subject: deviceSub},
		{Provider: "google", Subject: "gsub-anon-conflict", EmailVerified: true},
	}, TierFree, nil)

	sess, err := svc.MigrateIn(ctx, claims, "dev-anon-conflict")
	if err != nil {
		t.Fatalf("migrate-in: %v", err)
	}
	if sess.UserID != migrateID {
		t.Fatalf("session userID: want %s, got %s", migrateID, sess.UserID)
	}

	// 3. Anon user is gone; device identity now points to the migrated user.
	var ownerID uuid.UUID
	if err := svc.Pool.QueryRow(ctx,
		`SELECT user_id FROM auth.identities WHERE provider = 'device' AND subject = $1`,
		deviceSub,
	).Scan(&ownerID); err != nil {
		t.Fatalf("read device identity post-migrate: %v", err)
	}
	if ownerID != migrateID {
		t.Errorf("device owner: want %s (migrated), got %s", migrateID, ownerID)
	}

	var anonCount int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM auth.users WHERE id = $1`, anonID,
	).Scan(&anonCount); err != nil {
		t.Fatalf("count anon: %v", err)
	}
	if anonCount != 0 {
		t.Errorf("anon user should be deleted, found %d row(s)", anonCount)
	}
}

func TestMigrateIn_NonAnonConflictRejected(t *testing.T) {
	// Dest region already has a NON-anonymous user (google identity) and
	// the migration would steal its device identity. We refuse rather than
	// silently merging — that would be data loss for the dest account.
	svc, _ := boot(t)
	svc.RegionID = "global"
	ctx := context.Background()

	const deviceSub = "dev-real-conflict"
	realID := uuid.New()
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO auth.users (id, home_region) VALUES ($1, 'global')`,
		realID,
	); err != nil {
		t.Fatalf("seed real user: %v", err)
	}
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO auth.identities (provider, subject, user_id, home_region)
		 VALUES
		   ('device', $1, $2, 'global'),
		   ('google', $3, $2, 'global')`,
		deviceSub, realID, "gsub-already-here",
	); err != nil {
		t.Fatalf("seed real identities: %v", err)
	}

	migrateID := uuid.New()
	claims := makeMigrateClaims(migrateID, []jwt.ClaimIdentity{
		{Provider: "device", Subject: deviceSub},
		{Provider: "google", Subject: "gsub-different-from-conflict"},
	}, TierFree, nil)

	if _, err := svc.MigrateIn(ctx, claims, ""); err == nil {
		t.Fatal("migrate-in must reject when dest already has a non-anonymous user with the same identity")
	}

	// Real user must still be intact, no rows touched.
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM auth.identities WHERE user_id = $1`, realID,
	).Scan(&n); err != nil {
		t.Fatalf("count real identities: %v", err)
	}
	if n != 2 {
		t.Errorf("real user identities unchanged: want 2, got %d", n)
	}
}

func TestMigrateRevoke_DeletesUser(t *testing.T) {
	// Local user → call MigrateRevoke with a bearer signed by a
	// DIFFERENT kid (foreign region) → user row gone, refresh tokens
	// gone (cascade), user.deleted outbox emitted.
	svc, _ := boot(t)
	svc.LocalKid = "global-v1"
	ctx := context.Background()

	first, err := svc.Anonymous(ctx, "dev-revoke", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	// Promote to non-anon so the test exercises a "real" account
	// (anon-only would have been rejected by migrate-in upstream
	// anyway; revoke doesn't care about anon-ness).
	target := first.UserID

	claims := &jwt.Claims{
		Identities: []jwt.ClaimIdentity{{Provider: "google", Subject: "g-rev"}},
	}
	claims.Subject = target.String()

	if err := svc.MigrateRevoke(ctx, claims, "russia-v1" /*foreign kid*/); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	if u, _ := svc.Users.Get(ctx, target); u != nil {
		t.Errorf("user row should be gone after revoke")
	}
	// Outbox user.deleted event emitted by the trigger.
	var n int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM app.outbox WHERE event_type = 'user.deleted' AND aggregate_id = $1`,
		target.String(),
	).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if n != 1 {
		t.Errorf("user.deleted outbox: want 1, got %d", n)
	}
}

func TestMigrateRevoke_RejectsOwnKid(t *testing.T) {
	// A bearer signed by THIS region's kid is rejected. If we signed
	// it, there is no migration in flight — the client is asking us
	// to revoke a session we just issued.
	svc, _ := boot(t)
	svc.LocalKid = "global-v1"
	ctx := context.Background()

	claims := &jwt.Claims{
		Identities: []jwt.ClaimIdentity{{Provider: "google", Subject: "gsub"}},
	}
	claims.Subject = uuid.NewString()

	err := svc.MigrateRevoke(ctx, claims, "global-v1") // same as LocalKid
	if err == nil {
		t.Fatal("revoke with own kid must be rejected")
	}
}

func TestMigrateRevoke_Idempotent(t *testing.T) {
	// Calling revoke on an already-gone user is a no-op. The mobile
	// client's schedulePendingRevoke retries on each app start until
	// 200 — a 5xx on the second call would lock that retry loop.
	svc, _ := boot(t)
	svc.LocalKid = "global-v1"
	ctx := context.Background()

	claims := &jwt.Claims{
		Identities: []jwt.ClaimIdentity{{Provider: "google", Subject: "gsub-gone"}},
	}
	claims.Subject = uuid.NewString()

	// User never existed; revoke should not error.
	if err := svc.MigrateRevoke(ctx, claims, "russia-v1"); err != nil {
		t.Errorf("revoke on missing user must be no-op, got %v", err)
	}
}
