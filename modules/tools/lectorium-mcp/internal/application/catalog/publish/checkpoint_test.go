package publish

import (
	"bytes"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// A row written in WAL mode is invisible to anyone reading the database file as
// bytes until the log is folded in — which is exactly how publish reads it.
func TestCheckpointWAL_FoldsPendingWritesIntoTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "current.db")
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?_journal_mode=WAL", path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`create table collections (name text)`); err != nil {
		t.Fatal(err)
	}
	const marker = "Ретрит наставников, Коргашино, 2015"
	if _, err := db.Exec(`insert into collections (name) values (?)`, marker); err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(body, []byte(marker)) {
		t.Skip("this build checkpointed on its own; the guard cannot be observed here")
	}

	if err := checkpointWAL(t.Context(), path); err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	body, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(marker)) {
		t.Fatal("the write is still missing from the file — a publish would ship the previous catalog")
	}
	if _, err := os.Stat(path + "-wal"); err == nil {
		if fi, _ := os.Stat(path + "-wal"); fi.Size() != 0 {
			t.Fatalf("log not truncated: %d bytes left", fi.Size())
		}
	}
	_ = db.Close()
}
