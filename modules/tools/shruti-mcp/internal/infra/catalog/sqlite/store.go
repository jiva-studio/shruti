package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// ErrNotRefreshed is returned while no catalog has been downloaded yet.
var ErrNotRefreshed = errors.New("catalog not refreshed yet — run catalog_refresh first")

// Store is the one long-lived handle on current.db. The composition root
// opens it, running the migrations once, and every use case reads and writes
// through it. Install swaps a new file in once every in-flight call has
// finished; Snapshot takes a consistent copy for publishing.
type Store struct {
	path string
	mu   sync.RWMutex
	repo *Repo // nil while there is no file
}

// OpenStore opens current.db at path if it exists. A missing file is not an
// error: the store answers ErrNotRefreshed until Install puts one there.
func OpenStore(ctx context.Context, path string) (*Store, error) {
	s := &Store{path: path}
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		return s, nil
	} else if err != nil {
		return nil, fmt.Errorf("stat catalog: %w", err)
	}
	r, err := Open(ctx, path)
	if err != nil {
		return nil, err
	}
	s.repo = r
	return s, nil
}

// Path is where current.db lives.
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

// acquire holds the store open for one call; release must be called once the
// call is done with the repo.
func (s *Store) acquire() (*Repo, func(), error) {
	s.mu.RLock()
	if s.repo == nil {
		s.mu.RUnlock()
		return nil, nil, fmt.Errorf("%w (%s)", ErrNotRefreshed, s.path)
	}
	return s.repo, s.mu.RUnlock, nil
}

// Install replaces current.db with a copy of src. When backup is set, the
// file being replaced is kept there.
//
// The copy is staged beside current.db and checked before anything is
// touched, so a source that cannot be read or is not a database leaves the
// working catalog in place. Only then is the old database checkpointed and
// closed, its -wal and -shm sidecars removed (a log left beside the new file
// would be replayed into it on the next open), and the staged file renamed
// over it. On failure the store reopens whatever file is in place.
func (s *Store) Install(ctx context.Context, src, backup string) (err error) {
	staged, err := stageCopy(ctx, src, s.path)
	if err != nil {
		return err
	}
	defer func() {
		if err == nil {
			return
		}
		if rerr := os.Remove(staged); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
			err = errors.Join(err, rerr)
		}
	}()

	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		if err != nil && s.repo == nil {
			err = errors.Join(err, s.reopen(ctx))
		}
	}()

	if s.repo != nil {
		if err := s.repo.checkpoint(ctx); err != nil {
			return err
		}
		if err := s.repo.Close(); err != nil {
			return fmt.Errorf("close catalog: %w", err)
		}
		s.repo = nil
	}
	if err := removeSidecars(s.path); err != nil {
		return err
	}
	backedUp := false
	if backup != "" {
		switch err := os.Rename(s.path, backup); {
		case err == nil:
			backedUp = true
		case !errors.Is(err, fs.ErrNotExist):
			return fmt.Errorf("back up catalog: %w", err)
		}
	}
	if err := os.Rename(staged, s.path); err != nil {
		err = fmt.Errorf("install catalog: %w", err)
		if backedUp {
			if rerr := os.Rename(backup, s.path); rerr != nil {
				err = errors.Join(err, fmt.Errorf("restore catalog: %w", rerr))
			}
		}
		return err
	}
	r, err := Open(ctx, s.path)
	if err != nil {
		return err
	}
	s.repo = r
	return nil
}

// reopen opens the file at the store's path, if there is one.
func (s *Store) reopen(ctx context.Context) error {
	if _, err := os.Stat(s.path); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	r, err := Open(ctx, s.path)
	if err != nil {
		return fmt.Errorf("reopen catalog: %w", err)
	}
	s.repo = r
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

// stageCopy copies src into a temporary file beside dst and checks that the
// copy is a sound SQLite database. It returns the temporary file's path.
func stageCopy(ctx context.Context, src, dst string) (string, error) {
	staged, err := copyToTemp(src, dst)
	if err != nil {
		return "", err
	}
	if err := verifyDatabase(ctx, staged); err != nil {
		return "", errors.Join(err, os.Remove(staged), removeSidecars(staged))
	}
	return staged, nil
}

// verifyDatabase opens path read-only and runs SQLite's quick integrity
// check.
func verifyDatabase(ctx context.Context, path string) (err error) {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro", path))
	if err != nil {
		return fmt.Errorf("verify catalog copy: %w", err)
	}
	defer func() {
		err = errors.Join(err, db.Close())
	}()
	var result string
	if err := db.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&result); err != nil {
		return fmt.Errorf("verify catalog copy: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("verify catalog copy: %s", result)
	}
	return nil
}

// copyFileAtomic writes a copy of src to dst through a temporary file in
// dst's directory, so dst is either the old file or the whole new one.
func copyFileAtomic(src, dst string) error {
	tmp, err := copyToTemp(src, dst)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return errors.Join(err, os.Remove(tmp))
	}
	return nil
}

// copyToTemp writes a copy of src to a temporary file in dst's directory, so
// a later rename over dst is atomic. It returns the temporary file's path.
func copyToTemp(src, dst string) (_ string, err error) {
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".tmp-*")
	if err != nil {
		return "", err
	}
	defer func() {
		if err == nil {
			return
		}
		if cerr := tmp.Close(); cerr != nil && !errors.Is(cerr, os.ErrClosed) {
			err = errors.Join(err, cerr)
		}
		err = errors.Join(err, os.Remove(tmp.Name()))
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		return "", fmt.Errorf("copy %s: %w", filepath.Base(src), err)
	}
	if err := tmp.Sync(); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return tmp.Name(), nil
}
