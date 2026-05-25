package handlers

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	cwdb "github.com/akdasa-studios/lectorium/cleanup-worker/internal/db"
)

// dbDSNFromEnv mirrors the helpers in the worker / cron packages: skip the
// test cleanly if no integration DB is configured. Keeps `go test ./...`
// green on machines without Postgres.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run retention integration tests")
	}
	return dsn
}

// retentionSchemaLockKey serializes schema setup across test binaries.
// MUST match cron/anon_cleanup_test.go::schemaLockKey verbatim — Go runs
// each package's tests in its own binary and `go test ./...` runs them
// in parallel, so cron + handlers both DROP/CREATE app.outbox against the
// same DB. Sharing a single advisory key forces them to queue.
// (worker_test.go predates this convention and races on its own; that's
// a known wart, see TestSweepProcessesOldEvent flakes.)
const retentionSchemaLockKey int64 = 0x6c656374726d_01

// setupRetentionSchema rebuilds just the two tables the retention sweep
// touches. Trigger-fed columns (NOTIFY plumbing on app.outbox, the user-
// deleted trigger from 0023) are out of scope — retention only reads
// processed_at and deletes by primary key.
func setupRetentionSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin setup tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, retentionSchemaLockKey); err != nil {
		t.Fatalf("acquire advisory lock: %v", err)
	}

	stmts := []string{
		`DROP TABLE IF EXISTS app.outbox CASCADE`,
		`DROP TABLE IF EXISTS auth.rc_webhook_events CASCADE`,
		`CREATE SCHEMA IF NOT EXISTS auth`,
		`CREATE SCHEMA IF NOT EXISTS app`,
		`CREATE TABLE app.outbox (
			id           bigserial PRIMARY KEY,
			event_type   text NOT NULL,
			aggregate_id text NOT NULL,
			payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
			occurred_at  timestamptz NOT NULL DEFAULT now(),
			processed_at timestamptz
		)`,
		`CREATE TABLE auth.rc_webhook_events (
			event_id     TEXT PRIMARY KEY,
			received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
			processed_at TIMESTAMPTZ,
			error        TEXT
		)`,
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

// seedOutbox inserts n rows with processed_at = now() - age. age=0 means
// unprocessed (NULL processed_at), useful for asserting the partial filter.
func seedOutbox(t *testing.T, pool *pgxpool.Pool, eventType string, n int, age time.Duration) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		var processedExpr string
		args := []any{eventType, fmt.Sprintf("agg-%s-%d", eventType, i)}
		if age > 0 {
			processedExpr = `now() - $3::interval`
			args = append(args, age.String())
		} else {
			processedExpr = `NULL`
		}
		q := fmt.Sprintf(`INSERT INTO app.outbox (event_type, aggregate_id, processed_at)
		                  VALUES ($1, $2, %s)`, processedExpr)
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("seed outbox row %d: %v", i, err)
		}
	}
}

// seedWebhookEvents inserts n auth.rc_webhook_events rows ages back.
func seedWebhookEvents(t *testing.T, pool *pgxpool.Pool, n int, age time.Duration, prefix string) {
	t.Helper()
	ctx := context.Background()
	for i := 0; i < n; i++ {
		var processedExpr string
		args := []any{fmt.Sprintf("%s-%d", prefix, i)}
		if age > 0 {
			processedExpr = `now() - $2::interval`
			args = append(args, age.String())
		} else {
			processedExpr = `NULL`
		}
		q := fmt.Sprintf(`INSERT INTO auth.rc_webhook_events (event_id, processed_at)
		                  VALUES ($1, %s)`, processedExpr)
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatalf("seed webhook event %d: %v", i, err)
		}
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		fmt.Sprintf(`SELECT count(*) FROM %s`, table),
	).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// TestRetention_SweepDeletesAged matches the verification step from the plan:
// "100 rows with processed_at = now() - 91 days → daily tick → all 100
// deleted, counter = 100". We exercise both tables in the same test so the
// asserted counter snapshot covers the full Stats() surface.
func TestRetention_SweepDeletesAged(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupRetentionSchema(t, pool)

	// Outbox: 100 aged-out rows, 5 fresh rows (under TTL), 3 unprocessed.
	// Expected delete: 100. Survivors: 5 + 3 = 8.
	seedOutbox(t, pool, "subscription.changed", 100, 91*24*time.Hour)
	seedOutbox(t, pool, "subscription.changed", 5, 1*time.Hour)
	seedOutbox(t, pool, "user.deleted", 3, 0)

	// rc_webhook_events: 50 aged-out, 7 fresh.
	seedWebhookEvents(t, pool, 50, 91*24*time.Hour, "old")
	seedWebhookEvents(t, pool, 7, 24*time.Hour, "new")

	r := &Retention{
		Pool:             pool,
		Interval:         24 * time.Hour, // unused — we call SweepOnce directly
		WebhookEventsTTL: 90 * 24 * time.Hour,
		OutboxTTL:        30 * 24 * time.Hour,
	}
	if err := r.SweepOnce(context.Background()); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}

	if got := countRows(t, pool, "app.outbox"); got != 8 {
		t.Errorf("app.outbox survivors: got %d, want 8", got)
	}
	if got := countRows(t, pool, "auth.rc_webhook_events"); got != 7 {
		t.Errorf("auth.rc_webhook_events survivors: got %d, want 7", got)
	}

	stats := r.Stats()
	if got := stats.DeletedByTable["app.outbox"]; got != 100 {
		t.Errorf("deleted_total[app.outbox]: got %d, want 100", got)
	}
	if got := stats.DeletedByTable["auth.rc_webhook_events"]; got != 50 {
		t.Errorf("deleted_total[auth.rc_webhook_events]: got %d, want 50", got)
	}
}

// TestRetention_BatchesLoopUntilDrained guards the batched DELETE loop: with
// retentionBatchSize=1000, seeding >1k aged rows must result in a single
// SweepOnce call clearing every one of them. A buggy implementation that
// runs one batch and returns would leave the tail behind.
func TestRetention_BatchesLoopUntilDrained(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupRetentionSchema(t, pool)

	// 2500 outbox rows past TTL — requires three batches at size 1000.
	seedOutbox(t, pool, "subscription.changed", 2500, 60*24*time.Hour)

	r := &Retention{
		Pool:             pool,
		Interval:         24 * time.Hour,
		WebhookEventsTTL: 90 * 24 * time.Hour,
		OutboxTTL:        30 * 24 * time.Hour,
	}
	if err := r.SweepOnce(context.Background()); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}
	if got := countRows(t, pool, "app.outbox"); got != 0 {
		t.Errorf("app.outbox post-sweep: got %d rows, want 0 (all should be drained)", got)
	}
	if got := r.Stats().DeletedByTable["app.outbox"]; got != 2500 {
		t.Errorf("deleted_total[app.outbox]: got %d, want 2500", got)
	}
}

// TestRetention_PreservesUnprocessed locks in the most important invariant:
// retention NEVER touches rows whose processed_at IS NULL. If it did, the
// auth → cleanup-worker outbox plumbing would silently lose events.
func TestRetention_PreservesUnprocessed(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupRetentionSchema(t, pool)

	// All unprocessed — even with a tiny TTL, nothing should be deleted.
	seedOutbox(t, pool, "subscription.changed", 10, 0)
	seedWebhookEvents(t, pool, 10, 0, "unproc")

	r := &Retention{
		Pool:             pool,
		Interval:         24 * time.Hour,
		WebhookEventsTTL: 1 * time.Second,
		OutboxTTL:        1 * time.Second,
	}
	if err := r.SweepOnce(context.Background()); err != nil {
		t.Fatalf("SweepOnce: %v", err)
	}
	if got := countRows(t, pool, "app.outbox"); got != 10 {
		t.Errorf("unprocessed outbox rows must survive: got %d, want 10", got)
	}
	if got := countRows(t, pool, "auth.rc_webhook_events"); got != 10 {
		t.Errorf("unprocessed webhook events must survive: got %d, want 10", got)
	}
}
