// Reconciler orphan-sweep test — plan 1.3.
//
// Webhook rows whose rc_app_user_id never got bound to any auth.users
// row should be reaped after OrphanAfter elapses: the cron tries one
// last REST refetch and, on persistent matched=false, marks them
// processed with error='orphaned_no_link'. Skip-on-no-DB pattern
// mirrors internal/service/service_test.go.

package reconcile

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/auth/internal/rcclient"
	"github.com/jiva-studio/lectorium/auth/internal/service"
	"github.com/jiva-studio/lectorium/auth/internal/store"
)

const migrationsDir = "../../../../../infra/app/db/migrations"

func dbDSNFromEnv(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run reconcile-layer integration tests")
	}
	return dsn
}

func resetSchema(t *testing.T, dsn string) *pgxpool.Pool {
	t.Helper()
	pool, err := store.Connect(context.Background(), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS auth CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP SCHEMA IF EXISTS app CASCADE`)
	_, _ = pool.Exec(context.Background(), `DROP TABLE IF EXISTS public.schema_migrations`)

	files, _ := filepath.Glob(filepath.Join(migrationsDir, "000[0-9]_auth_*.up.sql"))
	more, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_auth_*.up.sql"))
	files = append(files, more...)
	webhook, _ := filepath.Glob(filepath.Join(migrationsDir, "002[0-9]_rc_webhook_*.up.sql"))
	files = append(files, webhook...)
	files = append(files, filepath.Join(migrationsDir, "0023_outbox.up.sql"))
	sort.Strings(files)
	for _, p := range files {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read migration %s: %v", p, err)
		}
		if _, err := pool.Exec(context.Background(), string(b)); err != nil {
			t.Fatalf("apply migration %s: %v", p, err)
		}
	}
	return pool
}

// rcStubAlwaysUnmatched returns an empty entitlements payload — every
// orphan sweep refetch will produce SnapshotFromRCResponse with
// Tier="free" and UpsertSubscriptionState will report matched=false
// (because there's still no auth.users row owning the rc_app_user_id).
func rcStubAlwaysUnmatched(t *testing.T) *rcclient.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"subscriber": map[string]any{
				"entitlements": map[string]any{},
			},
		})
	}))
	t.Cleanup(srv.Close)
	return &rcclient.Client{BaseURL: srv.URL, APIKey: "stub", HTTP: srv.Client()}
}

// TestOrphanSweepMarksAfter7Days — plan 1.3.
//
// Seed an unprocessed rc_webhook_events row whose received_at is
// older than the OrphanAfter cutoff and which never had any
// auth.users row bound to its rc_app_user_id. Run a single tick: the
// orphan sweep should re-fetch, see matched=false, then mark the row
// with processed_at != NULL and error='orphaned_no_link'.
func TestOrphanSweepMarksAfter7Days(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool := resetSchema(t, dsn)
	t.Cleanup(pool.Close)

	const eventID = "ev-orphan-1"
	const appUserID = "rc-app-user-truly-orphaned"

	// received_at = 10 days ago, processed_at = NULL.
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO auth.rc_webhook_events(event_id, app_user_id, received_at)
		 VALUES ($1, $2, now() - interval '10 days')`,
		eventID, appUserID,
	); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}

	svc := &service.Service{
		Pool:          pool,
		Users:         &store.UserRepo{Pool: pool},
		Identities:    &store.IdentityRepo{Pool: pool},
		RefreshTokens: &store.RefreshTokenRepo{Pool: pool},
		WebhookEvents: &store.WebhookEventRepo{Pool: pool},
	}
	rec := &Reconciler{
		Pool:          pool,
		Users:         svc.Users,
		WebhookEvents: svc.WebhookEvents,
		Svc:           svc,
		RC:            rcStubAlwaysUnmatched(t),
		Interval:      time.Hour,
		StaleAfter:    time.Hour, // immaterial — no stale users seeded
		BatchSize:     10,
		OrphanAfter:   7 * 24 * time.Hour,
	}

	rec.tick(context.Background())

	var processedAt *time.Time
	var errStr *string
	if err := pool.QueryRow(context.Background(),
		`SELECT processed_at, error FROM auth.rc_webhook_events WHERE event_id = $1`,
		eventID,
	).Scan(&processedAt, &errStr); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if processedAt == nil {
		t.Error("orphan sweep must stamp processed_at on aged unmatched rows")
	}
	if errStr == nil || *errStr != "orphaned_no_link" {
		t.Errorf("expected error='orphaned_no_link', got %v", errStr)
	}
}

// TestOrphanSweepSkipsRecentRows — defence against eating events
// that RC is still actively retrying. Anything received < OrphanAfter
// ago must stay unprocessed for the live webhook flow to handle.
func TestOrphanSweepSkipsRecentRows(t *testing.T) {
	dsn := dbDSNFromEnv(t)
	pool := resetSchema(t, dsn)
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(context.Background(),
		`INSERT INTO auth.rc_webhook_events(event_id, app_user_id, received_at)
		 VALUES ('ev-recent-1', 'rc-app-user-recent', now() - interval '1 hour')`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}

	svc := &service.Service{
		Pool:          pool,
		WebhookEvents: &store.WebhookEventRepo{Pool: pool},
		Users:         &store.UserRepo{Pool: pool},
	}
	rec := &Reconciler{
		Pool:          pool,
		Users:         svc.Users,
		WebhookEvents: svc.WebhookEvents,
		Svc:           svc,
		RC:            rcStubAlwaysUnmatched(t),
		OrphanAfter:   7 * 24 * time.Hour,
		BatchSize:     10,
	}
	rec.applyDefaults()
	rec.orphanSweep(context.Background())

	var processedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT processed_at FROM auth.rc_webhook_events WHERE event_id = 'ev-recent-1'`,
	).Scan(&processedAt); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if processedAt != nil {
		t.Errorf("recent row must remain unprocessed, got processed_at=%v", *processedAt)
	}
}
