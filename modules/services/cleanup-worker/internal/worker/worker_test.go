package worker

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	cwdb "github.com/jiva-studio/lectorium/cleanup-worker/internal/db"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/handlers"
)

// dbDSNFromEnv returns the dev/test DSN. If unset, the test skips with a
// clear message — same pattern as the auth service's service_test.go.
func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run worker integration tests")
	}
	return dsn
}

// setupSchema (re)creates a minimal app.outbox identical in shape to the
// production migration. We don't run the trigger setup or any auth
// migration here — the worker only ever reads/updates app.outbox, so the
// table alone is enough to exercise it.
func setupSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		`DROP TABLE IF EXISTS app.outbox`,
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
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatalf("setup schema %q: %v", s, err)
		}
	}
}

// insertEvent adds one row with occurred_at = now() - delta so we can
// control whether the sweep's "older than 30s" filter will pick it up.
func insertEvent(t *testing.T, pool *pgxpool.Pool, eventType, aggregateID string, delta time.Duration) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(context.Background(),
		`INSERT INTO app.outbox (event_type, aggregate_id, occurred_at)
		 VALUES ($1, $2, now() - $3::interval)
		 RETURNING id`,
		eventType, aggregateID, delta.String(),
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert event: %v", err)
	}
	return id
}

// recordingHandler captures every call so the test can assert what the
// worker passed it.
type recordingHandler struct {
	mu     sync.Mutex
	events []handlers.Event
	err    error
}

func (r *recordingHandler) handler() handlers.Handler {
	return func(_ context.Context, evt handlers.Event) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, evt)
		return r.err
	}
}

func (r *recordingHandler) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.events)
}

func processedAt(t *testing.T, pool *pgxpool.Pool, id int64) *time.Time {
	t.Helper()
	var ts *time.Time
	err := pool.QueryRow(context.Background(),
		`SELECT processed_at FROM app.outbox WHERE id = $1`, id,
	).Scan(&ts)
	if err != nil {
		t.Fatalf("read processed_at: %v", err)
	}
	return ts
}

func newWorker(t *testing.T, pool *pgxpool.Pool, reg *handlers.Registry) *Worker {
	t.Helper()
	// Tests don't exercise the LISTEN path (would need a long-lived conn +
	// timing-fragile NOTIFY assertions). The sweep loop covers the same
	// dispatch code path; ListenConn stays nil and we just don't call Run.
	return &Worker{
		Pool:          pool,
		Registry:      reg,
		SweepInterval: time.Second,
	}
}

func TestSweepProcessesOldEvent(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	rec := &recordingHandler{}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	// Older than the 30s sweep floor → must be picked up.
	id := insertEvent(t, pool, "user.deleted", "user-old", time.Minute)

	w := newWorker(t, pool, reg)
	if err := w.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if rec.count() != 1 {
		t.Fatalf("expected handler called once, got %d", rec.count())
	}
	if rec.events[0].AggregateID != "user-old" {
		t.Errorf("aggregate id mismatch: got %q", rec.events[0].AggregateID)
	}
	if processedAt(t, pool, id) == nil {
		t.Errorf("processed_at not stamped on success")
	}
}

func TestSweepSkipsTooFreshEvents(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	rec := &recordingHandler{}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	// Inside the 30s floor → sweep must NOT pick it up.
	id := insertEvent(t, pool, "user.deleted", "user-fresh", time.Second)

	w := newWorker(t, pool, reg)
	if err := w.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if rec.count() != 0 {
		t.Errorf("fresh event should be skipped by sweep, got %d calls", rec.count())
	}
	if processedAt(t, pool, id) != nil {
		t.Errorf("fresh event must NOT be stamped processed")
	}
}

func TestSweepLeavesRowUnprocessedOnHandlerError(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	rec := &recordingHandler{err: context.DeadlineExceeded}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	id := insertEvent(t, pool, "user.deleted", "user-fail", time.Minute)

	w := newWorker(t, pool, reg)
	if err := w.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if rec.count() != 1 {
		t.Fatalf("handler should have been called once, got %d", rec.count())
	}
	if processedAt(t, pool, id) != nil {
		t.Errorf("handler failure must leave processed_at NULL for retry")
	}
}

func TestSweepUnknownEventLeavesRow(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// Registry knows about user.deleted but not media.deleted.
	rec := &recordingHandler{}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	id := insertEvent(t, pool, "media.deleted", "track-42", time.Minute)

	w := newWorker(t, pool, reg)
	if err := w.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if rec.count() != 0 {
		t.Errorf("user.deleted handler must not see media.deleted")
	}
	if processedAt(t, pool, id) != nil {
		t.Errorf("unknown event type must not be marked processed (operator inspection)")
	}
}

func TestProcessByTypeTerminatesOnPoisonRow(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	// Handler always errors → the row never gets stamped processed, so the
	// claim query would re-select it forever without the zero-progress break.
	rec := &recordingHandler{err: context.DeadlineExceeded}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	id := insertEvent(t, pool, "user.deleted", "poison", 0)

	w := newWorker(t, pool, reg)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- w.processByType(ctx, "user.deleted") }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("processByType returned error: %v", err)
		}
	case <-ctx.Done():
		t.Fatalf("processByType did not terminate on a poison row (spun until deadline)")
	}

	if processedAt(t, pool, id) != nil {
		t.Errorf("poison row must stay unprocessed for the sweep to retry")
	}
}

func TestProcessByTypeFiltersByEventType(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool, err := cwdb.NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	setupSchema(t, pool)

	rec := &recordingHandler{}
	reg := handlers.NewRegistry()
	reg.Register("user.deleted", rec.handler())

	insertEvent(t, pool, "user.deleted", "u-1", 0)
	insertEvent(t, pool, "user.deleted", "u-2", 0)
	mediaID := insertEvent(t, pool, "media.deleted", "m-9", 0)

	w := newWorker(t, pool, reg)
	if err := w.processByType(context.Background(), "user.deleted"); err != nil {
		t.Fatalf("processByType: %v", err)
	}

	if rec.count() != 2 {
		t.Errorf("expected 2 user.deleted events processed, got %d", rec.count())
	}
	if processedAt(t, pool, mediaID) != nil {
		t.Errorf("media.deleted must remain unprocessed by user.deleted run")
	}
}
