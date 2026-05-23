// Package store holds Postgres repositories for auth.
//
// Migrations are NOT owned by this service — the central `migrator` compose
// container (golang-migrate against infra/db/migrations/) applies all SQL
// across services. Auth's boot sequence only opens a pool and asserts the
// expected tables are present.
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pool. The pool itself doesn't pin search_path; auth
// queries qualify objects with `auth.<table>` so any session works
// regardless of search_path.
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

// AssertSchemaReady fails loudly if the central migrator hasn't applied
// the auth schema yet. Defensive — `docker compose up` blocks dependent
// services until the migrator exits 0, but someone could still start
// auth standalone (`docker run`, dev mishap) and we'd rather crash with
// a clear message than spew confusing pgx errors on every query.
//
// Probes information_schema rather than the table itself so the result
// doesn't depend on whether any users exist yet (a fresh DB is fine).
func AssertSchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	const q = `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'auth' AND table_name = 'users'
	)`
	var exists bool
	if err := pool.QueryRow(probeCtx, q).Scan(&exists); err != nil {
		return fmt.Errorf("schema probe failed: %w", err)
	}
	if !exists {
		return fmt.Errorf("schema not migrated: auth.users missing — run `docker compose logs migrator`")
	}
	return nil
}
