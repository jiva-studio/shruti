package cron

// Integration tests for the signed-in TTL cron. Same skip-without-DSN
// pattern as anon_cleanup_test.go — `go test ./...` stays green without
// a Postgres dependency. Reuses setupSchema/seed/userExists/outboxRows
// helpers from anon_cleanup_test.go since both tests own the same
// schema slice.

import (
	"context"
	"testing"
	"time"

	cwdb "github.com/jiva-studio/shruti/cleanup-worker/internal/db"
)

// TestSignedInTTL_DeletesOnlyStaleSignedIn enforces the four cases the
// plan calls out:
//   - signed-in + recent token → STAY
//   - signed-in + stale token  → DELETE
//   - device-only + stale token → STAY (anon TTL territory)
//   - signed-in + no token     → DELETE (no row satisfies the > now-TTL clause)
//
// The outbox closure check confirms the user.deleted trigger fired
// exactly once per deletion — same path AnonCleanup relies on.
func TestSignedInTTL_DeletesOnlyStaleSignedIn(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// TTL=30d for the test; we age the "stale" tokens past it.
	ttl := 30 * 24 * time.Hour

	// A: signed-in with recent token → STAY.
	userA := seed(t, pool, seedUser{
		name: "signed-in-fresh", providers: []string{"device", "google"},
		tokenAgeAgo: 24 * time.Hour,
	})

	// B: signed-in with stale token → DELETE.
	userB := seed(t, pool, seedUser{
		name: "signed-in-stale", providers: []string{"device", "google"},
		tokenAgeAgo: 365 * 24 * time.Hour,
	})

	// C: device-only with stale token → STAY (anon TTL territory).
	userC := seed(t, pool, seedUser{
		name: "anon-stale", providers: []string{"device"},
		tokenAgeAgo: 365 * 24 * time.Hour,
	})

	// D: signed-in with NO token at all → DELETE (predicate's NOT EXISTS
	// on refresh_tokens > now-TTL is true when there are zero rows too).
	userD := seed(t, pool, seedUser{
		name: "signed-in-no-token", providers: []string{"apple"},
		tokenAgeAgo: 0,
	})

	c := &SignedInTTL{Pool: pool, Interval: time.Hour, TTL: ttl, DryRun: false}
	if err := c.sweepOnce(context.Background()); err != nil {
		t.Fatalf("sweepOnce: %v", err)
	}

	for _, id := range []string{userA, userC} {
		if !userExists(t, pool, id) {
			t.Errorf("expected user %s to survive sweep, got deleted", id)
		}
	}
	for _, id := range []string{userB, userD} {
		if userExists(t, pool, id) {
			t.Errorf("expected user %s to be deleted, still present", id)
		}
	}

	got := outboxRows(t, pool, "user.deleted")
	if len(got) != 2 {
		t.Fatalf("expected 2 user.deleted outbox rows, got %d: %v", len(got), got)
	}
	want := map[string]bool{userB: true, userD: true}
	for _, aid := range got {
		if !want[aid] {
			t.Errorf("unexpected user.deleted aggregate_id: %s", aid)
		}
	}
}

// TestSignedInTTL_DryRunDeletesNothing — the deployment-safety
// guarantee. Same fixture as the deletion test; the only difference is
// DryRun=true. Every user must survive; outbox must stay empty.
func TestSignedInTTL_DryRunDeletesNothing(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	ttl := 30 * 24 * time.Hour
	userB := seed(t, pool, seedUser{
		name: "signed-in-stale-dry", providers: []string{"google"},
		tokenAgeAgo: 365 * 24 * time.Hour,
	})
	userD := seed(t, pool, seedUser{
		name: "signed-in-no-token-dry", providers: []string{"apple"},
		tokenAgeAgo: 0,
	})

	c := &SignedInTTL{Pool: pool, Interval: time.Hour, TTL: ttl, DryRun: true}
	if err := c.sweepOnce(context.Background()); err != nil {
		t.Fatalf("sweepOnce dry: %v", err)
	}

	for _, id := range []string{userB, userD} {
		if !userExists(t, pool, id) {
			t.Errorf("dry-run must not delete user %s", id)
		}
	}
	if got := outboxRows(t, pool, "user.deleted"); len(got) != 0 {
		t.Errorf("dry-run must not emit outbox rows, got %d: %v", len(got), got)
	}
}

// TestSignedInTTL_RespectsDeviceProviderName — the predicate explicitly
// keys off provider != 'device'. A future provider that confusingly
// starts with 'device' (e.g. 'device-pro' if we ever add device-pinned
// tiers) must NOT be treated as anon. This nails the exact-match
// contract in case anyone tries to change it to LIKE 'device%'.
func TestSignedInTTL_RespectsDeviceProviderName(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// User has only a non-'device' provider whose name starts with
	// "device": must be treated as signed-in (predicate uses !=, not
	// NOT LIKE).
	u := seed(t, pool, seedUser{
		name: "fake-device-prefix", providers: []string{"deviceplus"},
		tokenAgeAgo: 365 * 24 * time.Hour,
	})

	c := &SignedInTTL{Pool: pool, Interval: time.Hour, TTL: 30 * 24 * time.Hour, DryRun: false}
	if err := c.sweepOnce(context.Background()); err != nil {
		t.Fatalf("sweepOnce: %v", err)
	}
	// Correct outcome: deleted. 'deviceplus' != 'device' makes this a
	// signed-in user; with a 365d-old token vs 30d TTL, it must go.
	if userExists(t, pool, u) {
		t.Errorf("user with 'deviceplus' provider must be classed signed-in (predicate uses !=)")
	}
}
