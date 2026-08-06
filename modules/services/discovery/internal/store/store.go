// Package store holds the discovery service's Postgres pool and embedded
// migrations.
//
// The service owns its database outright, so it carries its own migrations and
// its own ledger rather than going through the central migrator.
package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// migrateAdvisoryLockKey guards concurrent migrate runs.
const migrateAdvisoryLockKey = 0x646973636F76 // "discov" bytes, fits int64

// Connect opens a pool. Queries qualify objects with `discovery.<table>` so any
// session works regardless of search_path.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	return ConnectWith(ctx, dsn, 0)
}

// ConnectWith opens a pool of a stated size.
//
// The default is max(4, NumCPU), shared between the scheduler's workers, each
// source's own crawl workers and every HTTP handler — so on a small machine a
// busy crawl leaves the API waiting for a connection. maxConns of zero keeps
// the default, which is what the one-off subcommands want.
func ConnectWith(ctx context.Context, dsn string, maxConns int) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if maxConns > 0 {
		cfg.MaxConns = int32(maxConns)
	}
	// A connection that lives forever also holds a server-side backend forever,
	// through a failover it cannot see. These are unremarkable numbers; the
	// point is that they are stated rather than left to whatever pgx picks.
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 15 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

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

func migrationFiles() ([]string, error) {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}

// Migrate applies every embedded migration not yet recorded, once, under a
// session advisory lock. It is idempotent.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(migrateAdvisoryLockKey)); err != nil {
		return fmt.Errorf("advisory lock: %w", err)
	}
	defer func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, int64(migrateAdvisoryLockKey))
	}()

	if _, err := conn.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS discovery`); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS discovery.schema_migrations (
		version    text PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return fmt.Errorf("create ledger: %w", err)
	}

	names, err := migrationFiles()
	if err != nil {
		return err
	}
	for _, name := range names {
		var applied bool
		if err := conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM discovery.schema_migrations WHERE version = $1)`,
			name,
		).Scan(&applied); err != nil {
			return fmt.Errorf("check %s: %w", name, err)
		}
		if applied {
			continue
		}
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		// Each migration runs in its own transaction so a failure leaves a
		// clean ledger.
		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO discovery.schema_migrations (version) VALUES ($1)`, name,
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
	}
	return nil
}

// SchemaReady reports whether every embedded migration has been recorded.
// Drives /readyz.
func SchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	names, err := migrationFiles()
	if err != nil {
		return err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for _, name := range names {
		var applied bool
		if err := pool.QueryRow(probeCtx,
			`SELECT EXISTS (SELECT 1 FROM discovery.schema_migrations WHERE version = $1)`,
			name,
		).Scan(&applied); err != nil {
			return fmt.Errorf("schema probe failed: %w", err)
		}
		if !applied {
			return fmt.Errorf("migration %s not applied — run `discovery migrate`", name)
		}
	}
	return nil
}

// Pool is the connection this repository was built on. It exists for tests that
// have to look at a table this package has no reason to expose a reader for.
func (r *Repo) Pool() *pgxpool.Pool { return r.pool }
