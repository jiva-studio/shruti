package pending

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Exporter builds pending.db from the tracks the pool still holds as
// unpublished.
type Exporter struct {
	pool *pgxpool.Pool
}

// NewExporter returns an Exporter reading from pool.
func NewExporter(pool *pgxpool.Pool) *Exporter {
	return &Exporter{pool: pool}
}

// Export writes the unpublished rows into a fresh pending.db and returns its
// bytes with the number of tracks it holds.
func (e *Exporter) Export(ctx context.Context) ([]byte, int, error) {
	rows, err := QueryRows(ctx, e.pool)
	if err != nil {
		return nil, 0, err
	}
	dir, err := os.MkdirTemp("", "pending-db-")
	if err != nil {
		return nil, 0, fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "pending.db")
	if err := WriteDB(ctx, path, rows); err != nil {
		return nil, 0, err
	}
	db, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("read built db: %w", err)
	}
	return db, len(rows), nil
}
