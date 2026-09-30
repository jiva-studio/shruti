package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/infra/postgres"
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
	ctx := t.Context()
	pool, err := postgres.Connect(ctx, dsn)
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
	repo, err := postgres.NewOrders(pool)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()

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

	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pmtSrv.URL, paymentoKey: "k", authURL: authSrv.URL, hmacSecret: hmacSecret})

	o, err := repo.Create(ctx, uuid.New(), order.PlanMonthly, 299)
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
	got, _ := repo.Get(ctx, o.ID)
	if got.Status != order.StatusFulfilled {
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
	h := newRouteRouter(t, routeEnv{pool: pool, hmacSecret: hmacSecret})

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
	h := newRouteRouter(t, routeEnv{})
	req := httptest.NewRequest(http.MethodPost, "/webhooks/paymento", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured code = %d, want 503", rec.Code)
	}
}

// agedOrder is a created order with a token whose creation is backdated past
// the reconcile loop's 24h expiry cutoff.
func agedOrder(t *testing.T, pool *pgxpool.Pool, repo *postgres.Orders) *order.Order {
	t.Helper()
	ctx := t.Context()
	o, err := repo.Create(ctx, uuid.New(), order.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetToken(ctx, o.ID, "tok-"+o.ID.String()); err != nil {
		t.Fatal(err)
	}
	o.PaymentoToken = "tok-" + o.ID.String()
	if _, err := pool.Exec(ctx,
		`UPDATE billing.orders SET created_at = now() - interval '25 hours' WHERE id = $1`, o.ID); err != nil {
		t.Fatal(err)
	}
	return o
}

// countingAuth is an auth service that accepts every grant and counts them.
func countingAuth(t *testing.T) (*httptest.Server, *int32) {
	t.Helper()
	var grants int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&grants, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, &grants
}

func approveIPN(o *order.Order, paymentID string) string {
	return `{"Token":"` + o.PaymentoToken + `","PaymentId":"` + paymentID + `","OrderId":"` + o.ID.String() + `","OrderStatus":8}`
}

// Given an IPN approving an order near its cutoff, when the reconcile loop
// expires the order while the gateway is verifying it, then the approved
// payment is still honoured: fulfilled, payment recorded, granted once.
func TestWebhookApprovalRacingExpiryStillFulfils(t *testing.T) {
	pool := testPool(t)
	repo, err := postgres.NewOrders(pool)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	o := agedOrder(t, pool, repo)

	paymentID := uuid.NewString()
	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := repo.ExpireStale(r.Context(), 24*time.Hour); err != nil {
			t.Errorf("expire during verify: %v", err)
		}
		_, _ = w.Write([]byte(`{"orderStatus":"8","paymentId":"` + paymentID + `"}`))
	}))
	t.Cleanup(pmtSrv.Close)
	authSrv, grants := countingAuth(t)
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pmtSrv.URL, paymentoKey: "k", authURL: authSrv.URL, hmacSecret: hmacSecret})

	if code := postIPN(t, h, approveIPN(o, paymentID)); code != http.StatusOK {
		t.Fatalf("ipn code = %d, want 200", code)
	}
	got, err := repo.Get(ctx, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != order.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled: an approved payment was dropped because the order expired during verify", got.Status)
	}
	if got.PaymentoPaymentID != paymentID {
		t.Fatalf("payment id = %q, want %q", got.PaymentoPaymentID, paymentID)
	}
	if n := atomic.LoadInt32(grants); n != 1 {
		t.Fatalf("grants = %d, want 1", n)
	}
}

// Given an order the reconcile loop already expired, when an IPN approving its
// payment arrives, then the order is fulfilled and granted once, and a
// duplicate IPN grants nothing more.
func TestWebhookApprovalForExpiredOrderFulfils(t *testing.T) {
	pool := testPool(t)
	repo, err := postgres.NewOrders(pool)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	o := agedOrder(t, pool, repo)
	if _, err := repo.ExpireStale(ctx, 24*time.Hour); err != nil {
		t.Fatal(err)
	}

	paymentID := uuid.NewString()
	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"orderStatus":"8","paymentId":"` + paymentID + `"}`))
	}))
	t.Cleanup(pmtSrv.Close)
	authSrv, grants := countingAuth(t)
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pmtSrv.URL, paymentoKey: "k", authURL: authSrv.URL, hmacSecret: hmacSecret})

	body := approveIPN(o, paymentID)
	if code := postIPN(t, h, body); code != http.StatusOK {
		t.Fatalf("ipn code = %d, want 200", code)
	}
	got, err := repo.Get(ctx, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != order.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled: an approved payment on an expired order was ignored", got.Status)
	}
	if code := postIPN(t, h, body); code != http.StatusOK {
		t.Fatalf("dup ipn code = %d, want 200", code)
	}
	if n := atomic.LoadInt32(grants); n != 1 {
		t.Fatalf("grants = %d, want 1", n)
	}
}

// Given an expired order, when an IPN arrives but the gateway does not approve
// the payment, then the order stays expired and nothing is granted.
func TestWebhookUnapprovedExpiredOrderStaysExpired(t *testing.T) {
	pool := testPool(t)
	repo, err := postgres.NewOrders(pool)
	if err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	o := agedOrder(t, pool, repo)
	if _, err := repo.ExpireStale(ctx, 24*time.Hour); err != nil {
		t.Fatal(err)
	}

	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"orderStatus":"3"}`))
	}))
	t.Cleanup(pmtSrv.Close)
	authSrv, grants := countingAuth(t)
	h := newRouteRouter(t, routeEnv{pool: pool, paymentoURL: pmtSrv.URL, paymentoKey: "k", authURL: authSrv.URL, hmacSecret: hmacSecret})

	if code := postIPN(t, h, approveIPN(o, uuid.NewString())); code != http.StatusOK {
		t.Fatalf("ipn code = %d, want 200", code)
	}
	got, err := repo.Get(ctx, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != order.StatusExpired {
		t.Fatalf("status = %q, want expired", got.Status)
	}
	if n := atomic.LoadInt32(grants); n != 0 {
		t.Fatalf("grants = %d, want 0", n)
	}
}
