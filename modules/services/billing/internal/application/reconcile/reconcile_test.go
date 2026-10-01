package reconcile

import (
	"context"
	"io"
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

	"github.com/jiva-studio/shruti/billing/internal/application/fulfilment"
	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/infra/authgrant"
	"github.com/jiva-studio/shruti/billing/internal/infra/paymento"
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
		if os.Getenv("CI") != "" {
			t.Fatal("TEST_DATABASE_URL must be set in CI")
		}
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

func newOrders(t *testing.T, pool *pgxpool.Pool) *postgres.Orders {
	t.Helper()
	repo, err := postgres.NewOrders(pool)
	if err != nil {
		t.Fatal(err)
	}
	return repo
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
	repo := newOrders(t, pool)
	ctx := t.Context()

	pmtSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"orderStatus":"8","paymentId":"` + uuid.NewString() + `"}`))
	}))
	t.Cleanup(pmtSrv.Close)
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(authSrv.Close)

	d := &fulfilment.Service{
		Orders:  repo,
		Tx:      repo,
		Gateway: paymento.New(pmtSrv.URL, "k"),
		Granter: authgrant.New(authSrv.URL, "t"),
	}

	o, err := repo.Create(ctx, uuid.New(), order.PlanYearly, 2999)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.SetToken(ctx, o.ID, "tok"); err != nil {
		t.Fatal(err)
	}
	// Make it "stuck", and older than any other order a shared test database
	// holds, so the oldest-first batch picks it up.
	if _, err := pool.Exec(ctx, `UPDATE billing.orders SET updated_at = now() - interval '10 years' WHERE id=$1`, o.ID); err != nil {
		t.Fatal(err)
	}

	w := &Worker{Orders: repo, Driver: d, StuckAfter: time.Minute, BatchSize: 10}
	w.applyDefaults()
	w.tick(ctx)

	got, _ := repo.Get(ctx, o.ID)
	if got.Status != order.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled after reconcile", got.Status)
	}
}

// expiredOrder is an order with a token that the reconcile loop's 24h cutoff
// has expired, and its token.
func expiredOrder(t *testing.T, pool *pgxpool.Pool, repo *postgres.Orders) (*order.Order, string) {
	t.Helper()
	ctx := t.Context()
	o, err := repo.Create(ctx, uuid.New(), order.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	token := "tok-" + o.ID.String()
	if err := repo.SetToken(ctx, o.ID, token); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE billing.orders SET created_at = now() - interval '25 hours' WHERE id = $1`, o.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ExpireStale(ctx, 24*time.Hour); err != nil {
		t.Fatal(err)
	}
	return o, token
}

// stale backdates the order past any other in a shared test database, so the
// oldest-first batch reaches it.
func stale(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `UPDATE billing.orders SET updated_at = now() - interval '10 years' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}

// gateway answers verify with whatever reply returns, and counts the calls
// that carry token.
func gateway(t *testing.T, token string, calls *atomic.Int32, reply func(w http.ResponseWriter)) *paymento.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read verify: %v", err)
		}
		if strings.Contains(string(body), token) {
			calls.Add(1)
		}
		reply(w)
	}))
	t.Cleanup(srv.Close)
	return paymento.New(srv.URL, "k")
}

// Given an expired order whose approving IPN arrived while the gateway was
// down, when the gateway answers again, then the reconcile loop fulfils the
// order and grants it once.
func TestReconcileRedrivesExpiredOrderWhoseVerifyWentUnanswered(t *testing.T) {
	pool := testPool(t)
	repo := newOrders(t, pool)
	ctx := t.Context()
	o, token := expiredOrder(t, pool, repo)

	var down atomic.Bool
	down.Store(true)
	var calls, grants atomic.Int32
	pmt := gateway(t, token, &calls, func(w http.ResponseWriter) {
		if down.Load() {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"body":{"orderStatus":"8","paymentId":"` + uuid.NewString() + `"}}`))
	})
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read grant: %v", err)
		}
		if strings.Contains(string(body), o.ID.String()) {
			grants.Add(1)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(authSrv.Close)
	d := &fulfilment.Service{Orders: repo, Tx: repo, Gateway: pmt, Granter: authgrant.New(authSrv.URL, "t")}

	if err := d.Drive(ctx, o.ID); err == nil {
		t.Fatal("drive with the gateway down succeeded")
	}
	if got, _ := repo.Get(ctx, o.ID); got.Status != order.StatusExpired {
		t.Fatalf("status = %q, want expired while the gateway is down", got.Status)
	}

	down.Store(false)
	stale(t, pool, o.ID)
	w := &Worker{Orders: repo, Driver: d, StuckAfter: time.Minute, BatchSize: 10}
	w.applyDefaults()
	w.tick(ctx)

	got, _ := repo.Get(ctx, o.ID)
	if got.Status != order.StatusFulfilled {
		t.Fatalf("status = %q, want fulfilled: a paid expired order was stranded by a gateway outage", got.Status)
	}
	if n := grants.Load(); n != 1 {
		t.Fatalf("grants = %d, want 1", n)
	}
}

// Given an expired order the gateway already answered about, when the
// reconcile loop ticks, then it does not ask the gateway again and the order
// stays expired.
func TestReconcileLeavesAnsweredExpiredOrder(t *testing.T) {
	cases := map[string]struct {
		reply    string
		driveErr bool
	}{
		"not approved":  {reply: `{"success":false,"message":"Invalid Token","body":{"orderStatus":"Initialize"}}`},
		"another order": {reply: `{"success":true,"body":{"orderStatus":"8","orderId":"` + uuid.NewString() + `"}}`, driveErr: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			pool := testPool(t)
			repo := newOrders(t, pool)
			ctx := t.Context()
			o, token := expiredOrder(t, pool, repo)

			var calls atomic.Int32
			pmt := gateway(t, token, &calls, func(w http.ResponseWriter) { _, _ = w.Write([]byte(tc.reply)) })
			d := &fulfilment.Service{Orders: repo, Tx: repo, Gateway: pmt, Granter: authgrant.New("http://127.0.0.1:1", "t")}
			if err := d.Drive(ctx, o.ID); (err != nil) != tc.driveErr {
				t.Fatalf("drive err = %v, want error %v", err, tc.driveErr)
			}

			stale(t, pool, o.ID)
			w := &Worker{Orders: repo, Driver: d, StuckAfter: time.Minute, BatchSize: 10}
			w.applyDefaults()
			w.tick(ctx)

			if n := calls.Load(); n != 1 {
				t.Fatalf("verify calls = %d, want 1: an answered expired order was re-driven", n)
			}
			if got, _ := repo.Get(ctx, o.ID); got.Status != order.StatusExpired {
				t.Fatalf("status = %q, want expired", got.Status)
			}
		})
	}
}

// Given an expired order the gateway last called unpaid, when the approving
// IPN's request is cancelled while its verify is unanswered and the gateway
// then answers, then the reconcile loop fulfils the order.
func TestReconcileRedrivesExpiredOrderWhoseWebhookVerifyWasCancelled(t *testing.T) {
	pool := testPool(t)
	repo := newOrders(t, pool)
	ctx := t.Context()
	o, token := expiredOrder(t, pool, repo)

	var phase atomic.Int32
	var calls atomic.Int32
	inFlight := make(chan struct{}, 1)
	pmt := gateway(t, token, &calls, func(w http.ResponseWriter) {
		switch phase.Load() {
		case 0:
			_, _ = w.Write([]byte(`{"success":true,"body":{"orderStatus":"WaitingToConfirm"}}`))
		case 1:
			inFlight <- struct{}{}
			time.Sleep(200 * time.Millisecond)
			w.WriteHeader(http.StatusGatewayTimeout)
		default:
			_, _ = w.Write([]byte(`{"success":true,"body":{"orderStatus":"8","paymentId":"` + uuid.NewString() + `"}}`))
		}
	})
	authSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(authSrv.Close)
	d := &fulfilment.Service{Orders: repo, Tx: repo, Gateway: pmt, Granter: authgrant.New(authSrv.URL, "t")}

	if err := d.Drive(ctx, o.ID); err != nil {
		t.Fatal(err)
	}

	phase.Store(1)
	reqCtx, cancel := context.WithCancel(ctx)
	go func() {
		<-inFlight
		cancel()
	}()
	if err := d.Drive(reqCtx, o.ID); err == nil {
		t.Fatal("drive with the request cancelled succeeded")
	}

	phase.Store(2)
	stale(t, pool, o.ID)
	w := &Worker{Orders: repo, Driver: d, StuckAfter: time.Minute, BatchSize: 10}
	w.applyDefaults()
	w.tick(ctx)

	if got, _ := repo.Get(ctx, o.ID); got.Status != order.StatusFulfilled {
		t.Fatalf("status = %q, last_error = %q, want fulfilled: a paid expired order was stranded by a cancelled webhook", got.Status, got.LastError)
	}
}

// Given a batch's worth of older orders the loop cannot drive, when it ticks
// twice, then an expired order whose verify went unanswered is still reached.
func TestReconcileReachesUnansweredExpiredOrderPastUndrivableOnes(t *testing.T) {
	pool := testPool(t)
	repo := newOrders(t, pool)
	ctx := t.Context()
	const batch = 3
	for range batch {
		o, err := repo.Create(ctx, uuid.New(), order.PlanMonthly, 299)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE billing.orders SET updated_at = now() - interval '11 years' WHERE id=$1`, o.ID); err != nil {
			t.Fatal(err)
		}
	}
	o, token := expiredOrder(t, pool, repo)
	if err := repo.BumpAttempt(ctx, o.ID, order.VerifyUnanswered+"down"); err != nil {
		t.Fatal(err)
	}
	stale(t, pool, o.ID)

	var calls atomic.Int32
	pmt := gateway(t, token, &calls, func(w http.ResponseWriter) {
		_, _ = w.Write([]byte(`{"success":true,"body":{"orderStatus":"Initialize"}}`))
	})
	d := &fulfilment.Service{Orders: repo, Tx: repo, Gateway: pmt, Granter: authgrant.New("http://127.0.0.1:1", "t")}
	w := &Worker{Orders: repo, Driver: d, StuckAfter: time.Minute, BatchSize: batch}
	w.applyDefaults()
	w.tick(ctx)
	w.tick(ctx)

	if n := calls.Load(); n == 0 {
		t.Fatal("verify never asked: undrivable orders hold the head of every batch")
	}
}
