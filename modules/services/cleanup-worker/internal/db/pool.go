// Package db owns the pgx connection lifecycle for cleanup-worker.
//
// Two flavours: a pool for the sweep query (short-lived statements, picks
// up a fresh connection each call) and a dedicated long-lived *pgx.Conn
// used by the LISTEN goroutine. pgx pools intentionally don't let you pin
// a connection across calls, so LISTEN must own its own.
package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool opens the shared pool used by everything except the LISTEN
// goroutine. Same shape as the auth service's store.Connect.
func NewPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// NewListenConn opens a dedicated connection that the LISTEN goroutine
// owns until shutdown. We can't use a pool here because LISTEN state is
// connection-scoped: pgxpool would happily hand the same connection to
// another caller mid-LISTEN.
//
// Caller is responsible for `defer conn.Close(ctx)` on shutdown.
func NewListenConn(ctx context.Context, dsn string) (*pgx.Conn, error) {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("listen conn: %w", err)
	}
	return conn, nil
}

// AssertSchemaReady fails loudly if the central migrator hasn't applied
// 0023_outbox yet. Probes information_schema so the result doesn't depend
// on whether any events have been emitted yet.
func AssertSchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	const q = `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'app' AND table_name = 'outbox'
	)`
	var exists bool
	if err := pool.QueryRow(probeCtx, q).Scan(&exists); err != nil {
		return fmt.Errorf("schema probe failed: %w", err)
	}
	if !exists {
		return fmt.Errorf("schema not migrated: app.outbox missing — run `docker compose logs migrator`")
	}
	return nil
}
