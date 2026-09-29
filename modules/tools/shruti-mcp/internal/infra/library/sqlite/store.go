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

// Store is the long-lived handle on library.db, opened and migrated by the
// composition root. Reads need the file to exist; the first write creates it,
// so attributions can be curated before any import has run.
//
// The library import runs outside this process and puts a finished, closed
// file in place with a rename. Every call therefore compares the file at the
// path with the one the handle has open, and reopens when it is a different
// file (or appeared, or went away). Identity is the file itself, not its
// mtime or size: the store's own checkpoints move those without replacing
// anything. Writes still in the replaced file's log go with that file.
type Store struct {
	path   string
	mu     sync.RWMutex
	repo   *Repo       // nil until the file exists
	file   os.FileInfo // the file repo has open; nil with repo
	closed bool
}

// OpenStore opens library.db at path if it exists.
func OpenStore(ctx context.Context, path string) (*Store, error) {
	s := &Store{path: path}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.syncLocked(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Close releases the database. Calls after Close find no library.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return s.closeRepoLocked()
}

// acquire holds the store open for one read, first following a library.db
// replaced on disk.
func (s *Store) acquire(ctx context.Context) (*Repo, func(), error) {
	if err := s.follow(ctx); err != nil {
		return nil, nil, err
	}
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
	if err := s.syncLocked(ctx); err != nil {
		return nil, err
	}
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
	err := s.syncLocked(ctx)
	if err == nil && s.repo == nil && !s.closed {
		err = s.createLocked(ctx)
	}
	s.mu.Unlock()
	if err != nil {
		return nil, nil, err
	}
	return s.acquire(ctx)
}

// follow reopens the store when the file at its path is not the one it
// has open. The common case, the same file, takes only the shared lock.
func (s *Store) follow(ctx context.Context) error {
	cur, err := statFile(s.path)
	if err != nil {
		return err
	}
	s.mu.RLock()
	same := s.closed || sameFile(s.file, cur)
	s.mu.RUnlock()
	if same {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.syncLocked(ctx)
}

// syncLocked makes the handle match the file at the path: it closes a handle
// on a file that was replaced or removed and opens the one now there.
func (s *Store) syncLocked(ctx context.Context) error {
	if s.closed {
		return nil
	}
	cur, err := statFile(s.path)
	if err != nil {
		return err
	}
	if sameFile(s.file, cur) {
		return nil
	}
	if s.repo != nil {
		// The file the handle has open was replaced or removed. SQLite keeps
		// the -wal and -shm of a moved database on close, and opening the
		// new file beside them would replay the old file's log into it.
		if err := s.closeRepoLocked(); err != nil {
			return err
		}
		if err := removeSidecars(s.path); err != nil {
			return err
		}
	}
	if cur == nil {
		return nil
	}
	r, err := Open(ctx, s.path)
	if err != nil {
		return err
	}
	s.repo, s.file = r, cur
	return nil
}

// createLocked creates library.db and opens it.
func (s *Store) createLocked(ctx context.Context) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("ensure library dir: %w", err)
	}
	r, err := Open(ctx, s.path)
	if err != nil {
		return err
	}
	cur, err := statFile(s.path)
	if err != nil {
		return errors.Join(err, r.Close())
	}
	s.repo, s.file = r, cur
	return nil
}

// closeRepoLocked closes the open handle, if any.
func (s *Store) closeRepoLocked() error {
	if s.repo == nil {
		return nil
	}
	err := s.repo.Close()
	s.repo, s.file = nil, nil
	if err != nil {
		return fmt.Errorf("close library: %w", err)
	}
	return nil
}

// removeSidecars deletes a database's write-ahead log and shared-memory
// index.
func removeSidecars(path string) error {
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("remove %s: %w", filepath.Base(path+suffix), err)
		}
	}
	return nil
}

// statFile returns the file at path, or nil when there is none.
func statFile(path string) (os.FileInfo, error) {
	fi, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("stat library: %w", err)
	}
	return fi, nil
}

// sameFile reports whether a and b are the same file, or both absent.
func sameFile(a, b os.FileInfo) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return os.SameFile(a, b)
}
