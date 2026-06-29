package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/billing/internal/authclient"
	"github.com/jiva-studio/shruti/billing/internal/driver"
	"github.com/jiva-studio/shruti/billing/internal/orders"
	"github.com/jiva-studio/shruti/billing/internal/paymento"
	"github.com/jiva-studio/shruti/billing/internal/store"
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

const hmacSecret = "webhook-secret"

func postIPN(t *testing.T, h http.Handler, body string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/webhooks/paymento", strings.NewReader(body))
	req.Header.Set("X-HMAC-SHA256-SIGNATURE", sign([]byte(body), hmacSecret))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestWebhookApproveFulfillsAndIsIdempotent(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	ctx := context.Background()

	paymentID := uuid.NewString()
	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"orderStatus":"8","paymentId":"` + paymentID + `"}`))
	}))
	t.Cleanup(pmtSrv.Close)

	var grants int32
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&grants, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(authSrv.Close)

	d := &driver.Driver{
		Pool:     pool,
		Repo:     repo,
		Paymento: paymento.New(pmtSrv.URL, "k"),
		Auth:     authclient.New(authSrv.URL, "t"),
	}
	h := NewRouter(&BillingHandler{Repo: repo, Driver: d, HMACSecret: hmacSecret})

	o, err := repo.CreateOrder(ctx, uuid.New(), orders.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetToken(ctx, o.ID, "tok"); err != nil {
		t.Fatal(err)
	}

	// IPN with Approve (status 8).
	body := `{"Token":"tok","PaymentId":"` + paymentID + `","OrderId":"` + o.ID.String() + `","OrderStatus":8}`
	if code := postIPN(t, h, body); code != http.StatusOK {
		t.Fatalf("ipn code = %d, want 200", code)
	}
	got, _ := repo.GetByID(ctx, o.ID)
	if got.Status != orders.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled", got.Status)
	}
	if atomic.LoadInt32(&grants) != 1 {
		t.Fatalf("grants = %d, want 1", grants)
	}

	// Duplicate IPN with the same PaymentId → no-op, no second grant.
	if code := postIPN(t, h, body); code != http.StatusOK {
		t.Fatalf("dup ipn code = %d, want 200", code)
	}
	if atomic.LoadInt32(&grants) != 1 {
		t.Fatalf("grants after dup = %d, want 1", grants)
	}
}

func TestWebhookBadSignatureRejected(t *testing.T) {
	pool := testPool(t)
	repo := &store.Repo{Pool: pool}
	h := NewRouter(&BillingHandler{Repo: repo, Driver: &driver.Driver{Pool: pool, Repo: repo}, HMACSecret: hmacSecret})

	body := `{"OrderId":"x","OrderStatus":8}`
	req := httptest.NewRequest(http.MethodPost, "/webhooks/paymento", strings.NewReader(body))
	req.Header.Set("X-HMAC-SHA256-SIGNATURE", "BADBADBAD")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad sig code = %d, want 401", rec.Code)
	}
}

func TestWebhookUnconfiguredReturns503(t *testing.T) {
	// No DB needed — HMACSecret unset short-circuits before any DB access.
	h := NewRouter(&BillingHandler{HMACSecret: ""})
	req := httptest.NewRequest(http.MethodPost, "/webhooks/paymento", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured code = %d, want 503", rec.Code)
	}
}
