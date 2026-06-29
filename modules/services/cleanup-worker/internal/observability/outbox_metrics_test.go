package observability

// Integration tests for the outbox-pending gauge. Same skip-without-DSN
// pattern as the cron tests — Postgres is optional in unit-test mode.

import (
	"context"
	"os"
	"testing"
	"time"

	cwdb "github.com/jiva-studio/lectorium/cleanup-worker/internal/db"
	"github.com/jackc/pgx/v5/pgxpool"
	dto "github.com/prometheus/client_model/go"
)

func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run outbox-metrics integration tests")
	}
	return dsn
}

// schemaLockKey is the bigint key used with pg_advisory_xact_lock to
// serialize concurrent setupSchema callers across test binaries —
// mirrors the same idea in cron/anon_cleanup_test.go but with a
// different key value so the two test packages don't block each other.
const schemaLockKey int64 = 0x6c656374726d_02

// setupSchema rebuilds the slice of app.outbox the poller queries.
// Distinct from the cron-test setup: this one doesn't need auth.* (the
// poller never touches users/identities/tokens).
func setupSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

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
		`CREATE SCHEMA IF NOT EXISTS app`,
		`CREATE TABLE app.outbox (
			id           bigserial PRIMARY KEY,
			event_type   text NOT NULL,
			aggregate_id text NOT NULL,
			payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
			occurred_at  timestamptz NOT NULL DEFAULT now(),
			processed_at timestamptz
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

// insertOutbox writes one row with a controllable age. processedAgo > 0
// marks the row processed at that time-ago so we can assert the gauge
// ignores processed rows.
func insertOutbox(t *testing.T, pool *pgxpool.Pool, eventType string, ageAgo, processedAgo time.Duration) {
	t.Helper()
	ctx := context.Background()
	if processedAgo > 0 {
		_, err := pool.Exec(ctx, `
			INSERT INTO app.outbox (event_type, aggregate_id, payload, occurred_at, processed_at)
			VALUES ($1, gen_random_uuid()::text, '{}'::jsonb, now() - $2::interval, now() - $3::interval)`,
			eventType, ageAgo.String(), processedAgo.String(),
		)
		if err != nil {
			t.Fatalf("insert processed outbox: %v", err)
		}
		return
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO app.outbox (event_type, aggregate_id, payload, occurred_at)
		VALUES ($1, gen_random_uuid()::text, '{}'::jsonb, now() - $2::interval)`,
		eventType, ageAgo.String(),
	)
	if err != nil {
		t.Fatalf("insert outbox: %v", err)
	}
}

// gaugeValue reads the current gauge value for a specific label set.
// Uses the dto Metric to avoid testutil deps. Returns 0 when no metric
// exists for that label set (gauge series isn't registered).
func gaugeValue(t *testing.T, eventType string) float64 {
	t.Helper()
	m, err := OutboxPendingSeconds.GetMetricWithLabelValues(eventType)
	if err != nil {
		t.Fatalf("GetMetricWithLabelValues(%q): %v", eventType, err)
	}
	var pb dto.Metric
	if err := m.Write(&pb); err != nil {
		t.Fatalf("Write pb: %v", err)
	}
	return pb.GetGauge().GetValue()
}

// TestRefreshGauge_AgeIsApproximatelyCorrect — the load-bearing claim
// of the alert: gauge ≈ now()-MIN(occurred_at). Tolerance is generous
// (±10s) because each test step crosses a query-roundtrip boundary
// against a real DB.
func TestRefreshGauge_AgeIsApproximatelyCorrect(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	insertOutbox(t, pool, "user.deleted", 2*time.Hour, 0)

	if err := refreshGauge(context.Background(), pool); err != nil {
		t.Fatalf("refreshGauge: %v", err)
	}

	got := gaugeValue(t, "user.deleted")
	want := 7200.0
	if got < want-10 || got > want+30 { // +30 absorbs slow CI test machines
		t.Errorf("gauge for user.deleted = %.1fs, want ~%.0fs", got, want)
	}
}

// TestRefreshGauge_ProcessedRowsExcluded — processed_at IS NOT NULL is
// the steady state; if we accidentally counted those, every long-lived
// installation would page within hours.
func TestRefreshGauge_ProcessedRowsExcluded(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// One ancient processed row, one fresh unprocessed row.
	insertOutbox(t, pool, "user.deleted", 99*time.Hour, 98*time.Hour)
	insertOutbox(t, pool, "user.deleted", 1*time.Minute, 0)

	if err := refreshGauge(context.Background(), pool); err != nil {
		t.Fatalf("refreshGauge: %v", err)
	}

	got := gaugeValue(t, "user.deleted")
	// Must reflect the 1-minute unprocessed row, not the 99-hour processed one.
	if got > 600 { // generous upper bound — should be ~60s
		t.Errorf("processed rows leaked into gauge: user.deleted = %.1fs (>600)", got)
	}
}

// TestRefreshGauge_MultipleEventTypes — one series per event_type. The
// alert filters by series, so collapsing all event_types into one
// series would break the per-type runbook signal.
func TestRefreshGauge_MultipleEventTypes(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	insertOutbox(t, pool, "user.deleted", 3*time.Hour, 0)
	insertOutbox(t, pool, "subscription.changed", 30*time.Minute, 0)

	if err := refreshGauge(context.Background(), pool); err != nil {
		t.Fatalf("refreshGauge: %v", err)
	}

	gotUD := gaugeValue(t, "user.deleted")
	gotSC := gaugeValue(t, "subscription.changed")
	if gotUD < 10000 || gotUD > 12000 { // ~10800
		t.Errorf("user.deleted = %.1fs, want ~10800", gotUD)
	}
	if gotSC < 1700 || gotSC > 2000 { // ~1800
		t.Errorf("subscription.changed = %.1fs, want ~1800", gotSC)
	}
}

// TestRefreshGauge_ResetsStaleSeries — when a backlog drains, the
// corresponding gauge series must stop reporting. Without the Reset()
// inside refreshGauge the last non-zero value would linger forever and
// the alert would re-fire on stale data after a successful drain.
func TestRefreshGauge_ResetsStaleSeries(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// Tick 1: backlog exists.
	insertOutbox(t, pool, "user.deleted", 2*time.Hour, 0)
	if err := refreshGauge(context.Background(), pool); err != nil {
		t.Fatalf("refreshGauge tick1: %v", err)
	}
	if got := gaugeValue(t, "user.deleted"); got < 7000 {
		t.Fatalf("tick1: user.deleted = %.1fs, want ~7200", got)
	}

	// Tick 2: backlog drained (mark every row processed).
	if _, err := pool.Exec(context.Background(),
		`UPDATE app.outbox SET processed_at = now() WHERE processed_at IS NULL`); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if err := refreshGauge(context.Background(), pool); err != nil {
		t.Fatalf("refreshGauge tick2: %v", err)
	}
	if got := gaugeValue(t, "user.deleted"); got != 0 {
		t.Errorf("tick2: drained series still reports %.1fs (want 0 after Reset())", got)
	}
}
