// Package sqlitedb owns read-only access to the two published SQLite
// artifacts (library.db, current.db) and the CDN bootstrap that downloads and
// swaps them.
//
// It uses the pure-Go driver modernc.org/sqlite (no CGO) so the release image
// stays a static scratch container. Both files are opened read-only.
package sqlitedb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"sync"

	// Registers the pure-Go "sqlite" driver with database/sql.
	_ "modernc.org/sqlite"
)

// dsn builds a read-only modernc DSN for an absolute file path.
func dsn(path string) string {
	return fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", path)
}

// Open opens a read-only *sql.DB against path.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	db.SetMaxOpenConns(8)
	if err := db.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("ping sqlite %s: %w", path, err), db.Close())
	}
	return db, nil
}

// generation is one opened file. It is closed once it has been replaced (or
// the handle closed) and its last lease is released.
type generation struct {
	db      *sql.DB
	leases  int
	retired bool
}

// Handle holds the current database of a file the bootstrap may replace. A
// reader leases the current database for the length of one call; a swap opens
// the new file and retires the old database, which is closed when its last
// lease is released, so no query ever runs on a closed handle.
type Handle struct {
	path string
	mu   sync.Mutex
	cur  *generation
}

// NewHandle opens path and returns a live handle.
func NewHandle(ctx context.Context, path string) (*Handle, error) {
	db, err := Open(ctx, path)
	if err != nil {
		return nil, err
	}
	return &Handle{path: path, cur: &generation{db: db}}, nil
}

// ErrClosed is returned by Acquire after Close.
var ErrClosed = errors.New("sqlite handle closed")

// Acquire leases the current database. The caller must call release exactly
// once, when it no longer uses the database.
func (h *Handle) Acquire() (db *sql.DB, release func(), err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	g := h.cur
	if g == nil {
		return nil, nil, ErrClosed
	}
	g.leases++
	var once sync.Once
	return g.db, func() { once.Do(func() { h.release(g) }) }, nil
}

func (h *Handle) release(g *generation) {
	h.mu.Lock()
	g.leases--
	closeNow := g.retired && g.leases == 0
	h.mu.Unlock()
	if closeNow {
		closeRetired(h.path, g)
	}
}

// closeRetired closes a generation nobody leases any more. Nobody is left to
// return the error to, so it is logged.
func closeRetired(path string, g *generation) {
	if err := g.db.Close(); err != nil {
		log.Printf("sqlitedb: close retired %s: %v", path, err)
	}
}

// Reopen opens the (possibly swapped) file and makes it current. The previous
// database closes when its last lease is released.
func (h *Handle) Reopen(ctx context.Context) error {
	db, err := Open(ctx, h.path)
	if err != nil {
		return err
	}
	h.mu.Lock()
	old := h.cur
	if old == nil {
		h.mu.Unlock()
		return errors.Join(ErrClosed, db.Close())
	}
	h.cur = &generation{db: db}
	old.retired = true
	closeNow := old.leases == 0
	h.mu.Unlock()
	if closeNow {
		closeRetired(h.path, old)
	}
	return nil
}

// Close retires the current database; it is closed now when unleased, or when
// its last lease is released.
func (h *Handle) Close() error {
	h.mu.Lock()
	g := h.cur
	h.cur = nil
	if g == nil {
		h.mu.Unlock()
		return nil
	}
	g.retired = true
	closeNow := g.leases == 0
	h.mu.Unlock()
	if closeNow {
		return g.db.Close()
	}
	return nil
}
