package sqlitecatalog

import (
	"bytes"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "current.db")
	r, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := OpenStore(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func TestStoreWithoutAFileAnswersNotRefreshed(t *testing.T) {
	s, err := OpenStore(t.Context(), filepath.Join(t.TempDir(), "current.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Scheme(t.Context()); !errors.Is(err, ErrNotRefreshed) {
		t.Fatalf("Scheme on a missing catalog: %v", err)
	}
	if _, err := s.Snapshot(t.Context()); !errors.Is(err, ErrNotRefreshed) {
		t.Fatalf("Snapshot on a missing catalog: %v", err)
	}
}

// A write sits in the write-ahead log until a checkpoint; publish reads the
// file as bytes, so the snapshot has to carry it.
func TestSnapshotCarriesWritesStillInTheLog(t *testing.T) {
	s := openTestStore(t)
	const marker = "Ретрит наставников, Коргашино, 2015"
	if _, err := s.CreateDict(t.Context(), catalog.KindAuthor, catalog.DictEntry{
		ID: "author_m", Names: map[string]string{"ru": marker},
	}); err != nil {
		t.Fatal(err)
	}
	snap, err := s.Snapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := snap.Remove(); err != nil {
			t.Error(err)
		}
	})
	body, err := snap.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(marker)) {
		t.Fatal("the snapshot lacks a write that was still in the log")
	}
}

func TestWithdrawTranscriptsEditsOnlyTheSnapshot(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	r, release, err := s.acquire()
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO tracks (id) VALUES ('t1')`,
		`INSERT INTO track_variants (track_id, language, title, transcript_path, transcript_kind)
		 VALUES ('t1', 'ru', 'T', 'public/tracks/t1/transcripts/ru.json', 'generated'),
		        ('t1', 'en', 'T', 'public/tracks/t1/transcripts/en.json', 'generated')`,
		`INSERT INTO asset_hashes (path, sha256, track_id, language, kind) VALUES
		 ('public/tracks/t1/transcripts/ru.json', 'a', 't1', 'ru', 'transcript'),
		 ('public/tracks/t1/transcripts/en.json', 'b', 't1', 'en', 'transcript')`,
	} {
		if _, err := r.db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	release()

	snap, err := s.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := snap.Remove(); err != nil {
			t.Error(err)
		}
	})
	paths, err := snap.TranscriptAssets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(paths, []string{"public/tracks/t1/transcripts/en.json", "public/tracks/t1/transcripts/ru.json"}) {
		t.Fatalf("assets %v", paths)
	}
	if err := snap.WithdrawTranscripts(ctx, []string{"public/tracks/t1/transcripts/ru.json"}); err != nil {
		t.Fatal(err)
	}
	if paths, err = snap.TranscriptAssets(ctx); err != nil || len(paths) != 1 {
		t.Fatalf("after withdraw: %v %v", paths, err)
	}

	body, err := snap.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	shipped := filepath.Join(t.TempDir(), "shipped.db")
	if err := os.WriteFile(shipped, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if got := transcriptPointer(t, shipped, "ru"); got.Valid {
		t.Fatalf("the uploaded bytes still point at the withdrawn transcript: %q", got.String)
	}
	if got := transcriptPointer(t, s.Path(), "ru"); !got.Valid {
		t.Fatal("withdrawing from the snapshot cleared the working catalog")
	}
}

func transcriptPointer(t *testing.T, path, lang string) sql.NullString {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	var p sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT transcript_path FROM track_variants WHERE track_id = 't1' AND language = ?`, lang).Scan(&p); err != nil {
		t.Fatal(err)
	}
	return p
}

// Install must not let the replaced file's log leak into the new one.
func TestInstallReplacesTheFileUnderAnOpenStore(t *testing.T) {
	s := openTestStore(t)
	ctx := t.Context()
	if _, err := s.CreateDict(ctx, catalog.KindAuthor, catalog.DictEntry{
		ID: "author_old", Names: map[string]string{"en": "Old"},
	}); err != nil {
		t.Fatal(err)
	}

	next := filepath.Join(t.TempDir(), "next.db")
	r, err := Open(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.CreateDict(ctx, catalog.KindAuthor, catalog.DictEntry{
		ID: "author_new", Names: map[string]string{"en": "New"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}

	backup := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Install(ctx, next, backup); err != nil {
		t.Fatalf("install: %v", err)
	}
	if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, "author_new"); err != nil || !ok {
		t.Fatalf("installed catalog not served: %v %v", ok, err)
	}
	if _, ok, err := s.GetDict(ctx, catalog.KindAuthor, "author_old"); err != nil || ok {
		t.Fatalf("the replaced catalog still answers: %v %v", ok, err)
	}
	if _, err := os.Stat(backup); err != nil {
		t.Fatalf("no backup of the replaced catalog: %v", err)
	}
}
