// Package store holds the publish-service's Postgres pool and embedded
// migrations.
//
// Like the orchestrator (and unlike auth/chat, which use the central
// `migrator`), publish-service carries its OWN embedded migrations and runs
// them one-shot before serving — it fully owns its database (the `tracks` table
// is the source of truth for the promotion side).
package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// migrateAdvisoryLockKey guards concurrent migrate runs (two one-shot
// containers racing on boot). Serializes migration application across the fleet.
const migrateAdvisoryLockKey = 0x7075626C697368 // "publish" bytes, fits int64

// Connect opens a pool. Queries qualify objects with `publish.<table>` so any
// session works regardless of search_path.
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

// migrationFiles returns the embedded migration filenames sorted lexically
// (zero-padded prefixes give correct order).
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
// session advisory lock so parallel migrate containers don't collide. It is
// idempotent — already-applied versions are skipped.
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

	// The bookkeeping table lives in the publish schema, which the first
	// migration also creates — so create the schema + ledger defensively here.
	if _, err := conn.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS publish`); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS publish.schema_migrations (
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
			`SELECT EXISTS (SELECT 1 FROM publish.schema_migrations WHERE version = $1)`,
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
		// clean, partially-migrated-free ledger.
		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO publish.schema_migrations (version) VALUES ($1)`, name,
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

// SchemaReady reports whether every embedded migration has been recorded — i.e.
// the schema is current. Drives /readyz, which gates traffic until migrations
// have run.
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
			`SELECT EXISTS (SELECT 1 FROM publish.schema_migrations WHERE version = $1)`,
			name,
		).Scan(&applied); err != nil {
			return fmt.Errorf("schema probe failed: %w", err)
		}
		if !applied {
			return fmt.Errorf("migration %s not applied — run `publish-service migrate`", name)
		}
	}
	return nil
}

// querier lets repositories run against either a tx or the pool.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

var _ querier = (*pgxpool.Pool)(nil)
