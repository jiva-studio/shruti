package reconcile

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/billing/internal/authclient"
	"github.com/akdasa-studios/lectorium/billing/internal/driver"
	"github.com/akdasa-studios/lectorium/billing/internal/orders"
	"github.com/akdasa-studios/lectorium/billing/internal/paymento"
	"github.com/akdasa-studios/lectorium/billing/internal/store"
)

const schemaDDL = `
CREATE SCHEMA IF NOT EXISTS billing;
CREATE TABLE IF NOT EXISTS billing.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    plan text NOT NULL,
    amount_cents int NOT NULL,
    currency text NOT NULL DEFAULT 'USD',
    paymento_token text,
    paymento_payment_id text UNIQUE,
    status text NOT NULL DEFAULT 'created',
    attempts int NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    granted_at timestamptz
);
CREATE INDEX IF NOT EXISTS billing_orders_status_idx ON billing.orders(status);`

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping DB-backed test")
	}
	ctx := context.Background()
	pool, err := store.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := applySchema(ctx, pool); err != nil {
		t.Fatalf("ddl: %v", err)
	}
	return pool
}

// applySchema tolerates the catalog-level race (SQLSTATE 23505 on pg_namespace)
// that concurrent CREATE SCHEMA IF NOT EXISTS hits across parallel test
// packages — retry until the winning session has committed the schema.
func applySchema(ctx context.Context, pool *pgxpool.Pool) error {
	var err error
	for i := 0; i < 5; i++ {
		if _, err = pool.Exec(ctx, schemaDDL); err == nil {
			return nil
		}
		if pgErr, ok := err.(*pgconn.PgError); ok && pgErr.Code == "23505" {
			continue
		}
		return err
	}
	return err
}

// A 'created' order whose verify now returns Approve is re-driven to fulfilled
// by the reconcile tick — this is the lost-IPN self-heal path.
func TestReconcileRedrivesCreatedOrder(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	ctx := context.Background()

	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"orderStatus":"Approve","paymentId":"` + uuid.NewString() + `"}`))
	}))
	t.Cleanup(pmtSrv.Close)
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(authSrv.Close)

	d := &driver.Driver{
		Pool:     pool,
		Repo:     repo,
		Paymento: paymento.New(pmtSrv.URL, "k"),
		Auth:     authclient.New(authSrv.URL, "t"),
	}

	o, err := repo.CreateOrder(ctx, uuid.New(), orders.PlanYearly, 2999)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetToken(ctx, o.ID, "tok"); err != nil {
		t.Fatal(err)
	}
	// Make it "stuck": updated_at in the past so ListStuck picks it up.
	if _, err := pool.Exec(ctx, `UPDATE billing.orders SET updated_at = now() - interval '5 minutes' WHERE id=$1`, o.ID); err != nil {
		t.Fatal(err)
	}

	w := &Worker{Repo: repo, Driver: d, StuckAfter: time.Minute, BatchSize: 10}
	w.applyDefaults()
	w.tick(ctx)

	got, _ := repo.GetByID(ctx, o.ID)
	if got.Status != orders.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled after reconcile", got.Status)
	}
}
