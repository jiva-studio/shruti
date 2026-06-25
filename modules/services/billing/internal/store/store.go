// Package store holds the Postgres repository for billing orders.
//
// Migrations are NOT owned by this service — the central `migrator` container
// applies all SQL across services. Billing's boot sequence only opens a pool
// and asserts the billing.orders table is present.
//
// The order row is the source of truth for the resilient state machine, so the
// repository exposes both plain reads/writes and an AdvanceTx helper that locks
// the row (SELECT ... FOR UPDATE) before transitioning it — the webhook and the
// reconcile worker can race on the same order and must not double-apply.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/shruti/billing/internal/orders"
)

var ErrOrderNotFound = errors.New("store: order not found")

type Repo struct {
	Pool *pgxpool.Pool
}

func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(ctx2); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// AssertSchemaReady fails loudly if the central migrator hasn't created the
// billing.orders table yet, rather than spewing pgx errors on every query.
func AssertSchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	const q = `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'billing' AND table_name = 'orders'
	)`
	var exists bool
	if err := pool.QueryRow(probeCtx, q).Scan(&exists); err != nil {
		return fmt.Errorf("schema probe failed: %w", err)
	}
	if !exists {
		return fmt.Errorf("schema not migrated: billing.orders missing — run `docker compose logs migrator`")
	}
	return nil
}

const orderCols = `id, user_id, plan, amount_cents, currency,
	COALESCE(paymento_token,''), COALESCE(paymento_payment_id,''),
	status, attempts, COALESCE(last_error,'')`

func scanOrder(row pgx.Row) (*orders.Order, error) {
	var o orders.Order
	if err := row.Scan(&o.ID, &o.UserID, &o.Plan, &o.AmountCents, &o.Currency,
		&o.PaymentoToken, &o.PaymentoPaymentID, &o.Status, &o.Attempts, &o.LastError); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrOrderNotFound
		}
		return nil, err
	}
	return &o, nil
}

// CreateOrder inserts a fresh order in status=created.
func (r *Repo) CreateOrder(ctx context.Context, userID uuid.UUID, plan string, amountCents int) (*orders.Order, error) {
	const q = `INSERT INTO billing.orders (user_id, plan, amount_cents, currency, status)
		VALUES ($1, $2, $3, 'USD', 'created')
		RETURNING ` + orderCols
	return scanOrder(r.Pool.QueryRow(ctx, q, userID, plan, amountCents))
}

// SetToken stores the Paymento token returned by /payment/request.
func (r *Repo) SetToken(ctx context.Context, id uuid.UUID, token string) error {
	_, err := r.Pool.Exec(ctx,
		`UPDATE billing.orders SET paymento_token = $2, updated_at = now() WHERE id = $1`,
		id, token)
	return err
}

func (r *Repo) GetByID(ctx context.Context, id uuid.UUID) (*orders.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE id = $1`
	return scanOrder(r.Pool.QueryRow(ctx, q, id))
}

func (r *Repo) GetByPaymentID(ctx context.Context, paymentID string) (*orders.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE paymento_payment_id = $1`
	return scanOrder(r.Pool.QueryRow(ctx, q, paymentID))
}

// ListStuck returns orders still mid-flight (created/verified/granted) whose
// last update is older than olderThan — the reconcile worker re-drives them.
func (r *Repo) ListStuck(ctx context.Context, olderThan time.Duration, limit int) ([]*orders.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders
		WHERE status IN ('created','verified','granted')
		  AND updated_at < now() - $1::interval
		ORDER BY updated_at ASC
		LIMIT $2`
	rows, err := r.Pool.Query(ctx, q, intervalArg(olderThan), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*orders.Order
	for rows.Next() {
		o, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ExpireStale marks created orders that never got approved past cutoff as
// expired. Returns the count expired.
func (r *Repo) ExpireStale(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := r.Pool.Exec(ctx,
		`UPDATE billing.orders SET status = 'expired', updated_at = now()
		 WHERE status = 'created' AND created_at < now() - $1::interval`,
		intervalArg(olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// LockForUpdate begins a tx and selects the order FOR UPDATE so a concurrent
// webhook/reconcile can't double-advance it. The caller MUST Commit or Rollback
// the returned tx.
func (r *Repo) LockForUpdate(ctx context.Context, tx pgx.Tx, id uuid.UUID) (*orders.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE id = $1 FOR UPDATE`
	return scanOrder(tx.QueryRow(ctx, q, id))
}

// MarkVerified moves an order to verified and records the Paymento payment id
// (UNIQUE — the idempotency anchor for duplicate IPNs). Run inside the locking
// tx.
func MarkVerified(ctx context.Context, tx pgx.Tx, id uuid.UUID, paymentID string) error {
	_, err := tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'verified',
		   paymento_payment_id = COALESCE(NULLIF($2,''), paymento_payment_id),
		   last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id, paymentID)
	return err
}

// MarkGranted records that the auth grant succeeded (status=granted).
func MarkGranted(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'granted', granted_at = now(),
		   last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id)
	return err
}

// MarkFulfilled is the terminal success state.
func MarkFulfilled(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'fulfilled', last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id)
	return err
}

// BumpAttempt increments attempts and records the latest error without changing
// status — used when a step fails and is left for the next re-drive.
func (r *Repo) BumpAttempt(ctx context.Context, id uuid.UUID, errMsg string) error {
	_, err := r.Pool.Exec(ctx,
		`UPDATE billing.orders SET attempts = attempts + 1,
		   last_error = NULLIF($2,''), updated_at = now()
		 WHERE id = $1`,
		id, errMsg)
	return err
}

func intervalArg(d time.Duration) string {
	if d < time.Second {
		d = time.Second
	}
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}
