package sqlitepending

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pending"
	pendingport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/pending"
)

// Store is the one long-lived handle on pending.db, opened (and created when
// absent, so the admin tools see an empty queue before the first refresh) by
// the composition root. Install swaps a downloaded artifact in once every
// in-flight call has finished.
type Store struct {
	path string
	mu   sync.RWMutex
	repo *Repo
}

// OpenStore opens pending.db at path, creating it when absent.
func OpenStore(ctx context.Context, path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("ensure pending dir: %w", err)
	}
	r, err := Open(ctx, path)
	if err != nil {
		return nil, err
	}
	return &Store{path: path, repo: r}, nil
}

// Path is where pending.db lives.
func (s *Store) Path() string { return s.path }

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

// Install moves src over pending.db. The live database is closed and its
// -wal and -shm sidecars removed first, so no log from the old file is
// replayed into the new one.
func (s *Store) Install(ctx context.Context, src string) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo != nil {
		if err := s.repo.Close(); err != nil {
			return fmt.Errorf("close pending: %w", err)
		}
		s.repo = nil
	}
	defer func() {
		r, openErr := Open(ctx, s.path)
		if openErr != nil {
			err = errors.Join(err, openErr)
			return
		}
		s.repo = r
	}()
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(s.path + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("remove %s: %w", filepath.Base(s.path+suffix), err)
		}
	}
	if err := os.Rename(src, s.path); err != nil {
		return fmt.Errorf("swap pending.db: %w", err)
	}
	return nil
}

func (s *Store) acquire() (*Repo, func(), error) {
	s.mu.RLock()
	if s.repo == nil {
		s.mu.RUnlock()
		return nil, nil, fmt.Errorf("pending.db is closed (%s)", s.path)
	}
	return s.repo, s.mu.RUnlock, nil
}

func (s *Store) List(ctx context.Context, opts pending.ListOpts) ([]pending.Track, error) {
	r, release, err := s.acquire()
	if err != nil {
		return nil, err
	}
	defer release()
	return r.List(ctx, opts)
}

func (s *Store) Get(ctx context.Context, trackID string) (pending.Track, bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return pending.Track{}, false, err
	}
	defer release()
	return r.Get(ctx, trackID)
}

func (s *Store) MarkConsumed(ctx context.Context, trackID string) (bool, error) {
	r, release, err := s.acquire()
	if err != nil {
		return false, err
	}
	defer release()
	return r.MarkConsumed(ctx, trackID)
}

var (
	_ pendingport.Reader    = (*Store)(nil)
	_ pendingport.Installer = (*Store)(nil)
)
