// Package sqlitedb owns read-only access to the two published SQLite
// artifacts (library.db, current.db) plus the Bunny-CDN self-bootstrap that
// downloads and atomically swaps them (a Go port of chat's indexer).
//
// It uses the PURE-GO driver modernc.org/sqlite (no CGO) so the release image
// can stay a static scratch container. Both DBs are opened read-only.
package sqlitedb

import (
	"database/sql"
	"fmt"
	"sync"

	_ "modernc.org/sqlite"
)

// dsn builds a read-only modernc DSN for an absolute file path.
func dsn(path string) string {
	// mode=ro opens read-only; busy_timeout guards the brief window while a
	// swap-in-progress reopen races a reader.
	return fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", path)
}

// Open opens a read-only *sql.DB against path.
func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	db.SetMaxOpenConns(4)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite %s: %w", path, err)
	}
	return db, nil
}

// Handle wraps an atomically-swappable *sql.DB. When the bootstrap swaps the
// underlying file (a new inode via os.Rename), Reopen() opens a fresh *sql.DB
// against the new inode and retires the old one; readers holding DB() keep
// working until they finish.
type Handle struct {
	path string
	mu   sync.RWMutex
	db   *sql.DB
}

// NewHandle opens path and returns a live handle.
func NewHandle(path string) (*Handle, error) {
	db, err := Open(path)
	if err != nil {
		return nil, err
	}
	return &Handle{path: path, db: db}, nil
}

// DB returns the current read-only database.
func (h *Handle) DB() *sql.DB {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.db
}

// Reopen opens a fresh connection to the (possibly swapped) file and retires
// the previous one.
func (h *Handle) Reopen() error {
	nb, err := Open(h.path)
	if err != nil {
		return err
	}
	h.mu.Lock()
	old := h.db
	h.db = nb
	h.mu.Unlock()
	if old != nil {
		// Best-effort close of the retired inode; in-flight queries hold
		// their own conns until done.
		go old.Close()
	}
	return nil
}

// Close closes the current database.
func (h *Handle) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db == nil {
		return nil
	}
	return h.db.Close()
}
