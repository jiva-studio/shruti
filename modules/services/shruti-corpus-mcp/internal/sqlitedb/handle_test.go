package sqlitedb

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func writeDB(t *testing.T, path, value string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`DROP TABLE IF EXISTS v`,
		`CREATE TABLE v (x TEXT)`,
		`INSERT INTO v VALUES ('` + value + `')`,
	} {
		if _, err := db.ExecContext(t.Context(), q); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
}

func readValue(t *testing.T, db *sql.DB) string {
	t.Helper()
	var x string
	if err := db.QueryRowContext(t.Context(), `SELECT x FROM v`).Scan(&x); err != nil {
		t.Fatalf("read: %v", err)
	}
	return x
}

func TestLeaseOutlivesASwapAndClosesTheOldDatabaseAfterRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.db")
	writeDB(t, path, "old")
	h, err := NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})

	old, release, err := h.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	next := filepath.Join(t.TempDir(), "n.db")
	writeDB(t, next, "new")
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	if err := h.Reopen(t.Context()); err != nil {
		t.Fatal(err)
	}

	if got := readValue(t, old); got != "old" {
		t.Fatalf("the leased database reads %q after the swap", got)
	}
	cur, releaseCur, err := h.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	if got := readValue(t, cur); got != "new" {
		t.Fatalf("a lease taken after the swap reads %q", got)
	}
	releaseCur()

	release()
	release() // a second release is a no-op
	if err := old.PingContext(t.Context()); err == nil {
		t.Fatal("the retired database is still open after its last release")
	}
}

func TestUnleasedDatabaseClosesOnSwap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.db")
	writeDB(t, path, "old")
	h, err := NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	old, release, err := h.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	release()
	if err := h.Reopen(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := old.PingContext(t.Context()); err == nil {
		t.Fatal("an unleased retired database stayed open")
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Acquire(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Acquire after Close: %v", err)
	}
}

func TestConcurrentLeasesAndSwaps(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.db")
	writeDB(t, path, "v")
	h, err := NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				db, release, err := h.Acquire()
				if err != nil {
					errs <- err
					return
				}
				var x string
				err = db.QueryRowContext(t.Context(), `SELECT x FROM v`).Scan(&x)
				release()
				if err != nil {
					errs <- err
					return
				}
			}
		}()
	}
	for range 10 {
		if err := h.Reopen(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("a leased read failed across swaps: %v", err)
	}
}
