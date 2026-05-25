package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AssertSchemaReady verifies public.tasks exists. Equivalent of the
// Node assertSchema.ts. We use `SELECT 1 FROM public.tasks LIMIT 0`
// instead of querying information_schema because (a) it actually
// touches the table (rejecting permission errors at boot, not later)
// and (b) it forces pgxpool to acquire a real connection synchronously.
// (Rate-limit usage lives in Redis now; nothing else in Postgres to
// probe.)
func AssertSchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, "SELECT 1 FROM public.tasks LIMIT 0"); err != nil {
		return fmt.Errorf("public.tasks not migrated (hint: docker compose logs migrator): %w", err)
	}
	return nil
}
