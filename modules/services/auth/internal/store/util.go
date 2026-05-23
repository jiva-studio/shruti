package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// selectRow runs QueryRow either inside an active tx or against the pool.
func selectRow(ctx context.Context, pool *pgxpool.Pool, tx pgx.Tx, sql string, args ...any) pgx.Row {
	if tx != nil {
		return tx.QueryRow(ctx, sql, args...)
	}
	return pool.QueryRow(ctx, sql, args...)
}

// exec runs Exec either inside an active tx or against the pool.
func exec(ctx context.Context, pool *pgxpool.Pool, tx pgx.Tx, sql string, args ...any) (any, error) {
	if tx != nil {
		ct, err := tx.Exec(ctx, sql, args...)
		return ct, err
	}
	ct, err := pool.Exec(ctx, sql, args...)
	return ct, err
}
