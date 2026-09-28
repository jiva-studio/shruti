package sqlitelibrary

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// ErrNoLibrary is returned by a read while library.db does not exist.
var ErrNoLibrary = errors.New("library.db not found — import it first")

// Store is the one long-lived handle on library.db, opened and migrated once
// by the composition root. Reads need the file to exist; the first write
// creates it, so attributions can be curated before any import has run.
type Store struct {
	path string
	mu   sync.RWMutex
	repo *Repo // nil until the file exists
}

// OpenStore opens library.db at path if it exists.
func OpenStore(ctx context.Context, path string) (*Store, error) {
	s := &Store{path: path}
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		return s, nil
	} else if err != nil {
		return nil, fmt.Errorf("stat library: %w", err)
	}
	r, err := Open(ctx, path)
	if err != nil {
		return nil, err
	}
	s.repo = r
	return s, nil
}

// Close releases the database.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo == nil {
		return nil
	}
	err := s.repo.Close()
	s.repo = nil
	return err
}

// acquire holds the store open for one read.
func (s *Store) acquire() (*Repo, func(), error) {
	s.mu.RLock()
	if s.repo == nil {
		s.mu.RUnlock()
		return nil, nil, fmt.Errorf("%w (%s)", ErrNoLibrary, s.path)
	}
	return s.repo, s.mu.RUnlock, nil
}

// Snapshot returns library.db as it would be uploaded. It holds the store
// exclusively while it folds the write-ahead log into the file and reads it,
// so the bytes are one committed state that includes every write so far.
func (s *Store) Snapshot(ctx context.Context) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo == nil {
		return nil, fmt.Errorf("%w (%s)", ErrNoLibrary, s.path)
	}
	var busy, logPages, moved int
	if err := s.repo.db.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).
		Scan(&busy, &logPages, &moved); err != nil {
		return nil, fmt.Errorf("checkpoint library: %w", err)
	}
	if busy != 0 {
		return nil, fmt.Errorf("checkpoint library: blocked by an open reader (%d pages left)", logPages)
	}
	return os.ReadFile(s.path)
}

// acquireForWrite holds the store open for one write, creating library.db
// first when there is none.
func (s *Store) acquireForWrite(ctx context.Context) (*Repo, func(), error) {
	s.mu.Lock()
	if s.repo == nil {
		if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
			s.mu.Unlock()
			return nil, nil, fmt.Errorf("ensure library dir: %w", err)
		}
		r, err := Open(ctx, s.path)
		if err != nil {
			s.mu.Unlock()
			return nil, nil, err
		}
		s.repo = r
	}
	s.mu.Unlock()
	return s.acquire()
}
