package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// poolT aliases the pool type so test helpers across this package read cleanly.
type poolT = pgxpool.Pool

// EnsureSchema creates the billing.orders table for DB-backed tests. Mirrors
// the central migrator's 0040_billing_init migration; test-only (this file is a
// _test.go) so the shipped binary never creates schema itself.
func EnsureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	const ddl = `
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
	return applySchemaDDL(ctx, pool, ddl)
}

// applySchemaDDL runs schema DDL, tolerating the catalog-level race that
// concurrent CREATE SCHEMA IF NOT EXISTS hits across parallel test packages
// (SQLSTATE 23505 on pg_namespace). Retries a few times — by then the winning
// session has committed the schema and the IF NOT EXISTS is a clean no-op.
func applySchemaDDL(ctx context.Context, pool *pgxpool.Pool, ddl string) error {
	var err error
	for i := 0; i < 5; i++ {
		if _, err = pool.Exec(ctx, ddl); err == nil {
			return nil
		}
		if pgErr, ok := err.(*pgconn.PgError); ok && pgErr.Code == "23505" {
			continue
		}
		return err
	}
	return err
}
