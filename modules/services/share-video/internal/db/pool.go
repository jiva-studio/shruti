// Package db owns the pgxpool and the SQL operations against
// public.tasks (queue) and public.usage (daily quotas). Both tables are
// shared with the chat service and migrated by the central migrator.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool builds a pgxpool with the same caps the Node service used
// (max:5, idle:30s) so two services don't fight over Postgres's
// connection limit.
func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.MaxConns = 5
	cfg.MaxConnIdleTime = 30 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: %w", err)
	}
	return pool, nil
}
