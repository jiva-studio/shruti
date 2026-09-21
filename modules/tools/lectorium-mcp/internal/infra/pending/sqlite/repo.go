// Package sqlitepending is the SQLite adapter over the pending.db promotion
// queue artifact (issue #1233). Read/consume side only — the prod producer
// that populates pending.db is out of scope for the offline admin MCP.
//
// Mirrors the shape of internal/infra/catalog/sqlite and .../library/sqlite:
// an Open that self-heals the schema (additive, idempotent), a Repo with
// typed reads, and a Lazy open-on-demand wrapper.
package sqlitepending

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	// registers the sqlite3 driver with database/sql.
	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pending"
)

// Repo wraps the fetched pending.db (out/artifacts/pending/pending.db).
type Repo struct {
	db   *sql.DB
	path string
}

// Open opens (creating if absent) a pending.db and ensures the `pending`
// table exists. Auto-creating on open keeps the admin tools usable before the
// first artifact refresh — an empty queue rather than a hard error.
func Open(ctx context.Context, path string) (*Repo, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=30000", path)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open pending: %w", err)
	}
	db.SetMaxOpenConns(2)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping pending: %w", err)
	}
	if err := ensurePendingTable(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ensure pending table: %w", err)
	}
	return &Repo{db: db, path: path}, nil
}

func (r *Repo) Close() error { return r.db.Close() }

const pendingColumns = `track_id, owner_id,
	COALESCE(title_raw,''), COALESCE(author_raw,''), COALESCE(location_raw,''),
	COALESCE(date_raw,''), COALESCE(references_raw,''), lang,
	COALESCE(transcript_path,''), COALESCE(audio_path,''),
	COALESCE(audio_duration_ms,0), COALESCE(audio_size_bytes,0),
	COALESCE(created_at,''), COALESCE(consumed_at,'')`

func scanTrack(sc interface{ Scan(...any) error }) (pending.Track, error) {
	var t pending.Track
	err := sc.Scan(&t.TrackID, &t.OwnerID, &t.TitleRaw, &t.AuthorRaw, &t.LocationRaw,
		&t.DateRaw, &t.ReferencesRaw, &t.Lang, &t.TranscriptPath, &t.AudioPath,
		&t.AudioDurationMs, &t.AudioSizeBytes, &t.CreatedAt, &t.ConsumedAt)
	return t, err
}

// List returns pending rows ordered by (created_at, track_id). By default
// only unconsumed rows are returned.
func (r *Repo) List(ctx context.Context, opts pending.ListOpts) ([]pending.Track, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	q := `SELECT ` + pendingColumns + ` FROM pending WHERE 1=1`
	args := []any{}
	if !opts.IncludeConsumed {
		q += ` AND (consumed_at IS NULL OR consumed_at = '')`
	}
	if opts.Cursor != "" {
		q += ` AND track_id > ?`
		args = append(args, opts.Cursor)
	}
	q += ` ORDER BY track_id LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []pending.Track
	for rows.Next() {
		t, err := scanTrack(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get returns one pending row by track_id.
func (r *Repo) Get(ctx context.Context, trackID string) (pending.Track, bool, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT `+pendingColumns+` FROM pending WHERE track_id = ?`, trackID)
	t, err := scanTrack(row)
	if errors.Is(err, sql.ErrNoRows) {
		return pending.Track{}, false, nil
	}
	if err != nil {
		return pending.Track{}, false, err
	}
	return t, true, nil
}

// MarkConsumed sets consumed_at = now for a pending row. Idempotent.
func (r *Repo) MarkConsumed(ctx context.Context, trackID string) (bool, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE pending SET consumed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE track_id = ?`,
		trackID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ensurePendingTable creates the `pending` promotion-queue table when absent.
// Additive + idempotent (mirrors the catalog/library migration pattern) so
// Open is safe against both a freshly-created empty DB and a producer-written
// artifact that already carries the table.
func ensurePendingTable(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS pending (
			track_id          TEXT NOT NULL PRIMARY KEY,
			owner_id          TEXT NOT NULL,
			title_raw         TEXT,
			author_raw        TEXT,
			location_raw      TEXT,
			date_raw          TEXT,
			references_raw    TEXT,
			lang              TEXT NOT NULL,
			transcript_path   TEXT,
			audio_path        TEXT,
			audio_duration_ms INTEGER,
			audio_size_bytes  INTEGER,
			created_at      TEXT,
			consumed_at       TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pending_unconsumed
			ON pending(consumed_at, created_at)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply pending DDL: %w", err)
		}
	}
	return nil
}
