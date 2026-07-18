package sqlitecatalog

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// setupTrackAudioSchema builds the legacy single-audio shape (audio_* columns
// on track_variants) so we can verify the migration backfills track_audio.
func setupTrackAudioSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	stmts := []string{
		`CREATE TABLE tracks (
			id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
			date TEXT, hidden INTEGER DEFAULT 0)`,
		`CREATE TABLE track_variants (
			track_id TEXT, language TEXT, title TEXT,
			audio_path TEXT, audio_filesize INTEGER, audio_duration INTEGER,
			audio_kind TEXT, transcript_path TEXT, transcript_kind TEXT,
			sort_reference TEXT,
			PRIMARY KEY (track_id, language))`,
		`CREATE TABLE migrations (
			name TEXT PRIMARY KEY, scheme INTEGER, applied_at INTEGER NOT NULL)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("setup: %s: %v", s, err)
		}
	}
}

func TestEnsureTrackAudioTable_BackfillsOriginal(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:?_foreign_keys=on")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	setupTrackAudioSchema(t, db)

	// One variant with audio, one without (no audio_path → no backfill row).
	mustExec(t, db, `INSERT INTO tracks (id) VALUES ('t1'), ('t2')`)
	mustExec(t, db, `INSERT INTO track_variants
		(track_id, language, title, audio_path, audio_filesize, audio_duration, audio_kind)
		VALUES ('t1','ru','T', 'public/tracks/t1/audio/original.mp3', 123, 456000, 'edited')`)
	mustExec(t, db, `INSERT INTO track_variants (track_id, language, title) VALUES ('t2','en','T2')`)

	if err := ensureTrackAudioTable(ctx, db); err != nil {
		t.Fatalf("ensureTrackAudioTable: %v", err)
	}

	// Backfilled row exists as 'original' with the variant's audio values.
	var kind, path string
	var size, dur int64
	row := db.QueryRowContext(ctx,
		`SELECT kind, path, filesize, duration FROM track_audio WHERE track_id='t1' AND language='ru'`)
	if err := row.Scan(&kind, &path, &size, &dur); err != nil {
		t.Fatalf("scan backfilled row: %v", err)
	}
	if kind != "original" || path != "public/tracks/t1/audio/original.mp3" || size != 123 || dur != 456000 {
		t.Errorf("got kind=%q path=%q size=%d dur=%d", kind, path, size, dur)
	}

	// Variant without audio gets no row.
	var n int
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM track_audio WHERE track_id='t2'`).Scan(&n)
	if n != 0 {
		t.Errorf("expected no audio row for t2, got %d", n)
	}

	// Migration recorded with the bumped scheme.
	var scheme int
	db.QueryRowContext(ctx,
		`SELECT scheme FROM migrations WHERE name='005_add_track_audio'`).Scan(&scheme)
	if scheme != 20260614 {
		t.Errorf("migration scheme = %d, want 20260614", scheme)
	}

	// Idempotent: second run doesn't duplicate or error.
	if err := ensureTrackAudioTable(ctx, db); err != nil {
		t.Fatalf("second ensureTrackAudioTable: %v", err)
	}
	db.QueryRowContext(ctx, `SELECT COUNT(*) FROM track_audio`).Scan(&n)
	if n != 1 {
		t.Errorf("expected 1 audio row after re-run, got %d", n)
	}
}

func TestEnsureTrackContributorColumn(t *testing.T) {
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	mustExec(t, db, `CREATE TABLE tracks (
		id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
		date TEXT, hidden INTEGER DEFAULT 0)`)

	// Column absent before migration.
	has, err := columnExists(ctx, db, "tracks", "contributor_user_id")
	if err != nil {
		t.Fatalf("columnExists: %v", err)
	}
	if has {
		t.Fatal("contributor_user_id should not exist before migration")
	}

	if err := ensureTrackContributorColumn(ctx, db); err != nil {
		t.Fatalf("ensureTrackContributorColumn: %v", err)
	}

	has, err = columnExists(ctx, db, "tracks", "contributor_user_id")
	if err != nil {
		t.Fatalf("columnExists after: %v", err)
	}
	if !has {
		t.Fatal("contributor_user_id missing after migration")
	}

	// Writable + nullable: a row with an explicit attribution and one without.
	mustExec(t, db, `INSERT INTO tracks (id, contributor_user_id) VALUES ('t1', 'user_abc')`)
	mustExec(t, db, `INSERT INTO tracks (id) VALUES ('t2')`)
	var got sql.NullString
	if err := db.QueryRowContext(ctx,
		`SELECT contributor_user_id FROM tracks WHERE id='t1'`).Scan(&got); err != nil {
		t.Fatalf("scan t1: %v", err)
	}
	if !got.Valid || got.String != "user_abc" {
		t.Errorf("t1 contributor = %+v, want user_abc", got)
	}
	if err := db.QueryRowContext(ctx,
		`SELECT contributor_user_id FROM tracks WHERE id='t2'`).Scan(&got); err != nil {
		t.Fatalf("scan t2: %v", err)
	}
	if got.Valid {
		t.Errorf("t2 contributor should be NULL, got %q", got.String)
	}

	// Idempotent: second run is a no-op.
	if err := ensureTrackContributorColumn(ctx, db); err != nil {
		t.Fatalf("second ensureTrackContributorColumn: %v", err)
	}
}

func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}
