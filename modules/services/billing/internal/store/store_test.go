package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/billing/internal/orders"
	"github.com/google/uuid"
)

func TestCreateAndAdvanceOrder(t *testing.T) {
	pool := requireTestDB(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()

	uid := uuid.New()
	o, err := repo.CreateOrder(ctx, uid, orders.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	if o.Status != orders.StatusCreated || o.AmountCents != 299 {
		t.Fatalf("unexpected order: %+v", o)
	}

	if err := repo.SetToken(ctx, o.ID, "tok-123"); err != nil {
		t.Fatal(err)
	}
	got, err := repo.GetByID(ctx, o.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PaymentoToken != "tok-123" {
		t.Fatalf("token not persisted: %q", got.PaymentoToken)
	}

	// created orders older than cutoff expire.
	if _, err := pool.Exec(ctx, `UPDATE billing.orders SET created_at = now() - interval '2 days' WHERE id=$1`, o.ID); err != nil {
		t.Fatal(err)
	}
	n, err := repo.ExpireStale(ctx, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatal("expected at least one expired order")
	}
	got, _ = repo.GetByID(ctx, o.ID)
	if got.Status != orders.StatusExpired {
		t.Fatalf("status = %q, want expired", got.Status)
	}
}

// requireTestDB connects to TEST_DATABASE_URL and ensures the billing schema
// exists, skipping the test when the env var is unset (mirrors auth).
func requireTestDB(t *testing.T) *poolT {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping DB-backed test")
	}
	ctx := context.Background()
	pool, err := Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := EnsureSchema(ctx, pool); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	return pool
}
