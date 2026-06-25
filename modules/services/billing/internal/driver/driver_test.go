package driver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/shruti/billing/internal/authclient"
	"github.com/akdasa-studios/shruti/billing/internal/orders"
	"github.com/akdasa-studios/shruti/billing/internal/paymento"
	"github.com/akdasa-studios/shruti/billing/internal/store"
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

// fakePaymento serves /v1/payment/verify with a fixed orderStatus.
func fakePaymento(t *testing.T, orderStatus, paymentID string) *paymento.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"orderStatus":"` + orderStatus + `","paymentId":"` + paymentID + `"}`))
	}))
	t.Cleanup(srv.Close)
	return paymento.New(srv.URL, "test-key")
}

// fakeAuth serves /internal/subscription/grant, counting calls.
func fakeAuth(t *testing.T, status int) (*authclient.Client, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/subscription/grant" {
			atomic.AddInt32(&calls, 1)
			w.WriteHeader(status)
		}
	}))
	t.Cleanup(srv.Close)
	return authclient.New(srv.URL, "internal-token"), &calls
}

func newOrder(t *testing.T, repo *store.Repo) *orders.Order {
	t.Helper()
	ctx := context.Background()
	o, err := repo.CreateOrder(ctx, uuid.New(), orders.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetToken(ctx, o.ID, "tok-"+o.ID.String()); err != nil {
		t.Fatal(err)
	}
	return o
}

// Approve → grant → fulfilled.
func TestDriveApproveGrantsAndFulfills(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	auth, calls := fakeAuth(t, http.StatusOK)
	d := &Driver{Pool: pool, Repo: repo, Paymento: fakePaymento(t, "Approve", uuid.NewString()), Auth: auth}

	o := newOrder(t, repo)
	if err := d.Drive(context.Background(), o.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.GetByID(context.Background(), o.ID)
	if got.Status != orders.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled", got.Status)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("auth grant called %d times, want 1", *calls)
	}

	// Re-driving a fulfilled order must not call grant again (idempotent).
	if err := d.Drive(context.Background(), o.ID); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("re-drive grant called %d times, want 1", *calls)
	}
}

// verify-before-grant: verify != Approve → no grant, order stays created.
func TestDriveNotApprovedNoGrant(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	auth, calls := fakeAuth(t, http.StatusOK)
	d := &Driver{Pool: pool, Repo: repo, Paymento: fakePaymento(t, "Pending", ""), Auth: auth}

	o := newOrder(t, repo)
	if err := d.Drive(context.Background(), o.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := repo.GetByID(context.Background(), o.ID)
	if got.Status != orders.StatusCreated {
		t.Fatalf("status = %q, want created", got.Status)
	}
	if atomic.LoadInt32(calls) != 0 {
		t.Fatalf("auth grant called %d times, want 0", *calls)
	}
}

// grant failure leaves the order at verified for reconcile.
func TestDriveGrantFailureStaysVerified(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	auth, _ := fakeAuth(t, http.StatusInternalServerError)
	d := &Driver{Pool: pool, Repo: repo, Paymento: fakePaymento(t, "Approve", uuid.NewString()), Auth: auth}

	o := newOrder(t, repo)
	if err := d.Drive(context.Background(), o.ID); err == nil {
		t.Fatal("expected grant error")
	}
	got, _ := repo.GetByID(context.Background(), o.ID)
	if got.Status != orders.StatusVerified {
		t.Fatalf("status = %q, want verified", got.Status)
	}

	// Now the grant endpoint recovers; re-drive fulfills (self-heal).
	auth2, calls := fakeAuth(t, http.StatusOK)
	d.Auth = auth2
	if err := d.Drive(context.Background(), o.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = repo.GetByID(context.Background(), o.ID)
	if got.Status != orders.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled after recovery", got.Status)
	}
	if atomic.LoadInt32(calls) != 1 {
		t.Fatalf("recovery grant called %d times, want 1", *calls)
	}
}
