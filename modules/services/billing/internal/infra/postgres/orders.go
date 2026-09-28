// Package postgres stores billing orders in billing.orders.
//
// Migrations are not owned by this service: the central `migrator` container
// applies them. Billing's boot only opens a pool and asserts that the table
// is present.
package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/billing/internal/domain/order"
	"github.com/jiva-studio/shruti/billing/internal/ports"
)

// Connect opens a pool and pings it.
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

// Orders implements ports.Orders and ports.Transactor over one pool.
type Orders struct {
	pool *pgxpool.Pool
}

// NewOrders binds the order store to a pool.
func NewOrders(pool *pgxpool.Pool) (*Orders, error) {
	if pool == nil {
		return nil, errors.New("postgres: nil pool")
	}
	return &Orders{pool: pool}, nil
}

const orderCols = `id, user_id, plan, amount_cents, currency,
	COALESCE(paymento_token,''), COALESCE(paymento_payment_id,''),
	status, attempts, COALESCE(last_error,'')`

func scanOrder(row pgx.Row) (*order.Order, error) {
	var o order.Order
	if err := row.Scan(&o.ID, &o.UserID, &o.Plan, &o.AmountCents, &o.Currency,
		&o.PaymentoToken, &o.PaymentoPaymentID, &o.Status, &o.Attempts, &o.LastError); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ports.ErrOrderNotFound
		}
		return nil, err
	}
	return &o, nil
}

func (r *Orders) Create(ctx context.Context, userID uuid.UUID, plan string, amountCents int) (*order.Order, error) {
	const q = `INSERT INTO billing.orders (user_id, plan, amount_cents, currency, status)
		VALUES ($1, $2, $3, 'USD', 'created')
		RETURNING ` + orderCols
	return scanOrder(r.pool.QueryRow(ctx, q, userID, plan, amountCents))
}

func (r *Orders) SetToken(ctx context.Context, id uuid.UUID, token string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE billing.orders SET paymento_token = $2, updated_at = now() WHERE id = $1`,
		id, token)
	return err
}

func (r *Orders) Get(ctx context.Context, id uuid.UUID) (*order.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE id = $1`
	return scanOrder(r.pool.QueryRow(ctx, q, id))
}

func (r *Orders) GetByPaymentID(ctx context.Context, paymentID string) (*order.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE paymento_payment_id = $1`
	return scanOrder(r.pool.QueryRow(ctx, q, paymentID))
}

func (r *Orders) ListStuck(ctx context.Context, olderThan time.Duration, limit int) ([]*order.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders
		WHERE status IN ('created','verified','granted')
		  AND updated_at < now() - $1::interval
		ORDER BY updated_at ASC
		LIMIT $2`
	rows, err := r.pool.Query(ctx, q, intervalArg(olderThan), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*order.Order
	for rows.Next() {
		o, err := scanOrder(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (r *Orders) ExpireStale(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := r.pool.Exec(ctx,
		`UPDATE billing.orders SET status = 'expired', updated_at = now()
		 WHERE status = 'created' AND created_at < now() - $1::interval`,
		intervalArg(olderThan))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r *Orders) BumpAttempt(ctx context.Context, id uuid.UUID, errMsg string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE billing.orders SET attempts = attempts + 1,
		   last_error = NULLIF($2,''), updated_at = now()
		 WHERE id = $1`,
		id, errMsg)
	return err
}

// WithinTx runs fn in one transaction, committed when fn returns nil.
func (r *Orders) WithinTx(ctx context.Context, fn func(tx ports.OrderTx) error) error {
	return pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		return fn(orderTx{tx: tx})
	})
}

// orderTx is the order store bound to one transaction.
type orderTx struct {
	tx pgx.Tx
}

func (t orderTx) LockForUpdate(ctx context.Context, id uuid.UUID) (*order.Order, error) {
	const q = `SELECT ` + orderCols + ` FROM billing.orders WHERE id = $1 FOR UPDATE`
	return scanOrder(t.tx.QueryRow(ctx, q, id))
}

func (t orderTx) MarkVerified(ctx context.Context, id uuid.UUID, paymentID string) error {
	_, err := t.tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'verified',
		   paymento_payment_id = COALESCE(NULLIF($2,''), paymento_payment_id),
		   last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id, paymentID)
	return err
}

func (t orderTx) MarkGranted(ctx context.Context, id uuid.UUID) error {
	_, err := t.tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'granted', granted_at = now(),
		   last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id)
	return err
}

func (t orderTx) MarkFulfilled(ctx context.Context, id uuid.UUID) error {
	_, err := t.tx.Exec(ctx,
		`UPDATE billing.orders SET status = 'fulfilled', last_error = NULL, updated_at = now()
		 WHERE id = $1`,
		id)
	return err
}

func intervalArg(d time.Duration) string {
	if d < time.Second {
		d = time.Second
	}
	return fmt.Sprintf("%d seconds", int(d.Seconds()))
}
