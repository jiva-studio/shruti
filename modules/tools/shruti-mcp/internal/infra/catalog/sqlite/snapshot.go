package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// Snapshot copies current.db for publishing. It holds the store exclusively
// while it folds the write-ahead log in and copies the file, so the copy is
// one committed state. The copy is dot-prefixed so an asset walk skips it.
func (s *Store) Snapshot(ctx context.Context) (catalogport.Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo == nil {
		return nil, fmt.Errorf("%w (%s)", ErrNotRefreshed, s.path)
	}
	if err := s.repo.checkpoint(ctx); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".publish-*.db")
	if err != nil {
		return nil, fmt.Errorf("snapshot: %w", err)
	}
	name := tmp.Name()
	if err := tmp.Close(); err != nil {
		return nil, errors.Join(fmt.Errorf("snapshot: %w", err), os.Remove(name))
	}
	if err := copyFileAtomic(s.path, name); err != nil {
		return nil, errors.Join(fmt.Errorf("snapshot: %w", err), os.Remove(name))
	}
	return &snapshot{path: name}, nil
}

// snapshot is a private copy of the catalog; nothing else has it open.
type snapshot struct{ path string }

func (sn *snapshot) open() (*sql.DB, error) {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?_busy_timeout=15000", sn.path))
	if err != nil {
		return nil, fmt.Errorf("open snapshot: %w", err)
	}
	return db, nil
}

func (sn *snapshot) TranscriptAssets(ctx context.Context) (paths []string, err error) {
	db, err := sn.open()
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, db.Close()) }()
	rows, err := db.QueryContext(ctx,
		`SELECT path FROM asset_hashes WHERE kind = 'transcript' AND path <> '' ORDER BY path`)
	if err != nil {
		return nil, fmt.Errorf("read asset_hashes: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, fmt.Errorf("scan asset_hashes: %w", err)
		}
		paths = append(paths, p)
	}
	return paths, rows.Err()
}

// WithdrawTranscripts drops the asset_hashes rows the chat indexer lists and
// clears the variants' transcript pointers the clients resolve. The variant
// stays: a variant without a transcript is a normal state for every reader,
// while a missing variant would take the track's title with it.
func (sn *snapshot) WithdrawTranscripts(ctx context.Context, paths []string) (err error) {
	db, err := sn.open()
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, db.Close()) }()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range paths {
		if _, err := tx.ExecContext(ctx, `DELETE FROM asset_hashes WHERE path = ?`, p); err != nil {
			return fmt.Errorf("withdraw %s: %w", p, err)
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE track_variants SET transcript_path = NULL, transcript_kind = NULL
			 WHERE transcript_path = ?`, p); err != nil {
			return fmt.Errorf("withdraw %s (variant pointer): %w", p, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return (&Repo{db: db, path: sn.path}).checkpoint(ctx)
}

func (sn *snapshot) Bytes() ([]byte, error) { return os.ReadFile(sn.path) }

func (sn *snapshot) Remove() error {
	var errs []error
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(sn.path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

var (
	_ catalogport.Snapshotter = (*Store)(nil)
	_ catalogport.Installer   = (*Store)(nil)
)
