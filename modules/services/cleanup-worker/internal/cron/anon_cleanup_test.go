package cron

import (
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	cwdb "github.com/jiva-studio/shruti/cleanup-worker/internal/db"
)

// dbDSNFromEnv mirrors the worker package's helper. Same skip-when-unset
// pattern so `go test ./...` stays green without a Postgres dependency.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run anon-cleanup integration tests")
	}
	return dsn
}

// schemaLockKey is the bigint key used with pg_advisory_xact_lock to
// serialize concurrent setupSchema callers across test binaries. Go runs
// each package's tests in its own binary, and `go test ./...` runs those
// binaries in parallel; with worker_test.go and anon_cleanup_test.go both
// recreating app.outbox against the same DB, racing CREATE TABLEs would
// flake. The lock is committed-scoped so it auto-releases when setup's
// transaction commits.
const schemaLockKey int64 = 0x6c656374726d_01

// setupSchema rebuilds the slices of auth.* and app.* the cron job touches.
// Mirrors 0001_auth_init + 0023_outbox in shape (not in grants / indexes —
// only what the cron query and the trigger need). Idempotent: drops first.
func setupSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := t.Context()

	// Wrap the full setup in one transaction so the advisory lock guards
	// every CREATE — any racing binary blocks until we commit.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin setup tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, schemaLockKey); err != nil {
		t.Fatalf("acquire advisory lock: %v", err)
	}

	stmts := []string{
		`DROP TABLE IF EXISTS app.outbox CASCADE`,
		`DROP TABLE IF EXISTS auth.refresh_tokens`,
		`DROP TABLE IF EXISTS auth.identities`,
		`DROP TABLE IF EXISTS auth.users CASCADE`,
		`CREATE SCHEMA IF NOT EXISTS auth`,
		`CREATE SCHEMA IF NOT EXISTS app`,
		`CREATE TABLE auth.users (
			id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			name        text,
			created_at  timestamptz NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE auth.identities (
			provider        text NOT NULL,
			subject         text NOT NULL,
			user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
			email           text,
			email_verified  boolean NOT NULL DEFAULT false,
			created_at      timestamptz NOT NULL DEFAULT now(),
			PRIMARY KEY (provider, subject)
		)`,
		`CREATE TABLE auth.refresh_tokens (
			jti         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
			device_id   text,
			expires_at  timestamptz NOT NULL,
			revoked_at  timestamptz,
			created_at  timestamptz NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE app.outbox (
			id           bigserial PRIMARY KEY,
			event_type   text NOT NULL,
			aggregate_id text NOT NULL,
			payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
			occurred_at  timestamptz NOT NULL DEFAULT now(),
			processed_at timestamptz
		)`,
		// Mirror the production trigger so the cron's DELETE fans out into
		// app.outbox exactly the way it does in prod. We assert on this in
		// the test — without the trigger, the closed-loop claim is unproven.
		`CREATE OR REPLACE FUNCTION app.emit_user_deleted()
		 RETURNS trigger LANGUAGE plpgsql AS $$
		 BEGIN
		   INSERT INTO app.outbox (event_type, aggregate_id, payload)
		   VALUES ('user.deleted', OLD.id::text, '{}'::jsonb);
		   RETURN OLD;
		 END;
		 $$`,
		`DROP TRIGGER IF EXISTS trg_emit_user_deleted ON auth.users`,
		`CREATE TRIGGER trg_emit_user_deleted
		   AFTER DELETE ON auth.users
		   FOR EACH ROW
		   EXECUTE FUNCTION app.emit_user_deleted()`,
	}
	for _, s := range stmts {
		if _, err := tx.Exec(ctx, s); err != nil {
			t.Fatalf("setup schema %q: %v", s, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit setup tx: %v", err)
	}
}

type seedUser struct {
	name        string // human-readable label used in failure messages
	providers   []string
	tokenAgeAgo time.Duration // age of the newest refresh_token (0 = no token)
}

// seed inserts a user, the requested identities, and (if tokenAgeAgo > 0)
// one refresh_token with created_at = now() - tokenAgeAgo. Returns the
// user id so the test can assert presence/absence after the sweep.
func seed(t *testing.T, pool *pgxpool.Pool, su seedUser) string {
	t.Helper()
	ctx := t.Context()
	var id string
	if err := pool.QueryRow(ctx,
		`INSERT INTO auth.users (name) VALUES ($1) RETURNING id::text`, su.name,
	).Scan(&id); err != nil {
		t.Fatalf("insert user %q: %v", su.name, err)
	}
	for i, p := range su.providers {
		if _, err := pool.Exec(ctx,
			`INSERT INTO auth.identities (provider, subject, user_id)
			 VALUES ($1, $2, $3)`,
			p, su.name+"-"+p+"-"+itoa(i), id,
		); err != nil {
			t.Fatalf("insert identity %q for %q: %v", p, su.name, err)
		}
	}
	if su.tokenAgeAgo > 0 {
		if _, err := pool.Exec(ctx,
			`INSERT INTO auth.refresh_tokens (user_id, expires_at, created_at)
			 VALUES ($1, now() + interval '90 days', now() - $2::interval)`,
			id, su.tokenAgeAgo.String(),
		); err != nil {
			t.Fatalf("insert refresh_token for %q: %v", su.name, err)
		}
	}
	return id
}

func itoa(i int) string {
	// Avoids pulling strconv into this tiny helper. Two-digit safety is
	// plenty for the small seeds in these tests.
	const digits = "0123456789"
	if i < 10 {
		return string(digits[i])
	}
	return string(digits[i/10]) + string(digits[i%10])
}

func userExists(t *testing.T, pool *pgxpool.Pool, id string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(t.Context(),
		`SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = $1::uuid)`, id,
	).Scan(&exists); err != nil {
		t.Fatalf("userExists %s: %v", id, err)
	}
	return exists
}

func outboxRows(t *testing.T, pool *pgxpool.Pool, eventType string) []string {
	t.Helper()
	rows, err := pool.Query(t.Context(),
		`SELECT aggregate_id FROM app.outbox WHERE event_type = $1
		 ORDER BY occurred_at`, eventType,
	)
	if err != nil {
		t.Fatalf("outboxRows: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var aid string
		if err := rows.Scan(&aid); err != nil {
			t.Fatalf("scan outbox: %v", err)
		}
		out = append(out, aid)
	}
	return out
}

// TestAnonCleanup_DeletesOnlyStaleAnons is the end-to-end claim from the
// mission: 3 signed-in, 2 fresh anons, 2 stale anons → only the 2 stale
// anons disappear, and the outbox gets exactly 2 user.deleted rows.
func TestAnonCleanup_DeletesOnlyStaleAnons(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(t.Context(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// TTL = 30 days for the test; we age "stale" refresh tokens past it.
	ttl := 30 * 24 * time.Hour

	// 3 signed-in: google/apple identities, ancient refresh — must STAY
	// (identity != device wins regardless of token age).
	signedInGoogle := seed(t, pool, seedUser{
		name: "signed-in-google", providers: []string{"device", "google"},
		tokenAgeAgo: 400 * 24 * time.Hour,
	})
	signedInApple := seed(t, pool, seedUser{
		name: "signed-in-apple", providers: []string{"device", "apple"},
		tokenAgeAgo: 400 * 24 * time.Hour,
	})
	signedInNoToken := seed(t, pool, seedUser{
		name: "signed-in-no-token", providers: []string{"google"},
		tokenAgeAgo: 0,
	})

	// 2 fresh anons: device-only identity, refresh < TTL → must STAY.
	freshAnon1 := seed(t, pool, seedUser{
		name: "fresh-anon-1", providers: []string{"device"},
		tokenAgeAgo: 1 * time.Hour,
	})
	freshAnon2 := seed(t, pool, seedUser{
		name: "fresh-anon-2", providers: []string{"device"},
		tokenAgeAgo: 15 * 24 * time.Hour,
	})

	// 2 stale anons: device-only identity, refresh > TTL → must GO.
	staleAnon1 := seed(t, pool, seedUser{
		name: "stale-anon-1", providers: []string{"device"},
		tokenAgeAgo: 60 * 24 * time.Hour,
	})
	staleAnon2 := seed(t, pool, seedUser{
		name: "stale-anon-2", providers: []string{"device"},
		tokenAgeAgo: 365 * 24 * time.Hour,
	})

	c := &AnonCleanup{Pool: pool, Interval: time.Hour, TTL: ttl}
	if err := c.sweepOnce(t.Context()); err != nil {
		t.Fatalf("sweepOnce: %v", err)
	}

	// Survivors.
	for _, id := range []string{signedInGoogle, signedInApple, signedInNoToken, freshAnon1, freshAnon2} {
		if !userExists(t, pool, id) {
			t.Errorf("expected user %s to survive sweep, got deleted", id)
		}
	}
	// Casualties.
	for _, id := range []string{staleAnon1, staleAnon2} {
		if userExists(t, pool, id) {
			t.Errorf("expected user %s to be deleted, still present", id)
		}
	}

	// Outbox closure: exactly the two stale ids, no more, no less.
	got := outboxRows(t, pool, "user.deleted")
	if len(got) != 2 {
		t.Fatalf("expected 2 user.deleted outbox rows, got %d: %v", len(got), got)
	}
	want := map[string]bool{staleAnon1: true, staleAnon2: true}
	for _, aid := range got {
		if !want[aid] {
			t.Errorf("unexpected user.deleted aggregate_id: %s", aid)
		}
	}
}

// TestAnonCleanup_AnonWithNoTokenIsDeleted covers the edge case the SQL
// already handles via NOT EXISTS but the spec didn't enumerate: an anon
// user with zero refresh_tokens (signed in once on device, never came
// back, token already expired+pruned) must also go.
func TestAnonCleanup_AnonWithNoTokenIsDeleted(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(t.Context(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	id := seed(t, pool, seedUser{
		name: "anon-no-token", providers: []string{"device"},
		tokenAgeAgo: 0,
	})

	c := &AnonCleanup{Pool: pool, Interval: time.Hour, TTL: 30 * 24 * time.Hour}
	if err := c.sweepOnce(t.Context()); err != nil {
		t.Fatalf("sweepOnce: %v", err)
	}
	if userExists(t, pool, id) {
		t.Errorf("anon with no refresh_token must be deleted")
	}
}
