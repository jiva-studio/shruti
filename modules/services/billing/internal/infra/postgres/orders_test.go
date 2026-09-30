package postgres

import (
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jiva-studio/shruti/billing/internal/domain/order"
)

func TestCreateAndAdvanceOrder(t *testing.T) {
	pool := requireTestDB(t)
	repo := &Orders{pool: pool}
	ctx := t.Context()

	uid := uuid.New()
	o, err := repo.Create(ctx, uid, order.PlanMonthly, 299)
	if err != nil {
		t.Fatal(err)
	}
	if o.Status != order.StatusCreated || o.AmountCents != 299 {
		t.Fatalf("unexpected order: %+v", o)
	}

	if err := repo.SetToken(ctx, o.ID, "tok-123"); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Get(ctx, o.ID)
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
	got, _ = repo.Get(ctx, o.ID)
	if got.Status != order.StatusExpired {
		t.Fatalf("status = %q, want expired", got.Status)
	}
}

// requireTestDB connects to TEST_DATABASE_URL and ensures the billing schema
// exists. When the env var is unset the test fails if CI is set and skips
// otherwise.
func requireTestDB(t *testing.T) *poolT {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv("CI") != "" {
			t.Fatal("TEST_DATABASE_URL must be set in CI")
		}
		t.Skip("TEST_DATABASE_URL not set; skipping DB-backed test")
	}
	ctx := t.Context()
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
