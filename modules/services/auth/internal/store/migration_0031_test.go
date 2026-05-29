package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Path from this test file's directory to the central migrations folder.
const migrationsDir = "../../../../../infra/app/db/migrations"

// TestMigration0031DropsHomeRegion — pins the migration's observable
// effect: with auth.users.home_region + auth.identities.home_region
// present (state after 0028), applying 0031 leaves neither column on
// the table. A regression that ships an incomplete 0031 (e.g. drops
// only one of the two columns) trips this test before it lands in prod.
func TestMigration0031DropsHomeRegion(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run migration integration tests")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	// Reset auth schema and rebuild it through the 0001 + 0028 lineage
	// — the columns added by 0028 are exactly what 0031 will drop.
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS auth CASCADE`); err != nil {
		t.Fatalf("drop auth: %v", err)
	}
	for _, name := range []string{
		"0001_auth_init.up.sql",
		"0022_auth_user_picture.up.sql",
		"0025_auth_subscription.up.sql",
		"0027_rc_webhook_app_user_id.up.sql",
		"0028_auth_region_columns.up.sql",
	} {
		applySQLFile(t, pool, ctx, name)
	}

	if !columnExists(t, pool, ctx, "auth", "users", "home_region") {
		t.Fatal("precondition: auth.users.home_region must exist after 0028")
	}
	if !columnExists(t, pool, ctx, "auth", "identities", "home_region") {
		t.Fatal("precondition: auth.identities.home_region must exist after 0028")
	}

	applySQLFile(t, pool, ctx, "0031_drop_home_region.up.sql")

	if columnExists(t, pool, ctx, "auth", "users", "home_region") {
		t.Error("auth.users.home_region must be absent after 0031")
	}
	if columnExists(t, pool, ctx, "auth", "identities", "home_region") {
		t.Error("auth.identities.home_region must be absent after 0031")
	}
}

func applySQLFile(t *testing.T, pool *pgxpool.Pool, ctx context.Context, name string) {
	t.Helper()
	sqlBytes, err := os.ReadFile(filepath.Join(migrationsDir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if _, err := pool.Exec(ctx, string(sqlBytes)); err != nil {
		t.Fatalf("apply %s: %v", name, err)
	}
}

func columnExists(t *testing.T, pool *pgxpool.Pool, ctx context.Context, schema, table, column string) bool {
	t.Helper()
	var exists bool
	if err := pool.QueryRow(ctx,
		`SELECT EXISTS(
		    SELECT 1 FROM information_schema.columns
		     WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
		 )`,
		schema, table, column,
	).Scan(&exists); err != nil {
		t.Fatalf("information_schema lookup: %v", err)
	}
	return exists
}
