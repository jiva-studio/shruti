package catalog

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/sqlitedb"
)

// A catalog written by the current pipeline carries the duration in
// track_audio and leaves track_variants.audio_duration — the column the
// per-version audio model replaced — empty. Reading the old column returned 0
// for every track committed since that migration.
func TestDurationComesFromTrackAudio(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	stmts := []string{
		`CREATE TABLE tracks (id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
		   date TEXT, hidden INTEGER NOT NULL DEFAULT 0, contributor_user_id TEXT)`,
		`CREATE TABLE track_variants (track_id TEXT, language TEXT, title TEXT,
		   audio_duration INTEGER, transcript_path TEXT, outline TEXT,
		   PRIMARY KEY (track_id, language))`,
		`CREATE TABLE track_audio (track_id TEXT, language TEXT, kind TEXT, path TEXT,
		   filesize INTEGER, duration INTEGER, PRIMARY KEY (track_id, language, kind))`,
		`CREATE TABLE track_tags (track_id TEXT, tag_id TEXT)`,
		`CREATE TABLE track_references (track_id TEXT, ref_idx INTEGER, source_id TEXT, tokens TEXT)`,
		`INSERT INTO tracks (id, date) VALUES ('track_new', '2025-12-14'), ('track_old', '1974-11-12')`,
		// written by the current pipeline: old column empty
		`INSERT INTO track_variants (track_id, language, title, audio_duration)
		   VALUES ('track_new', 'ru', 'Сага о слоне Кешаве', NULL)`,
		`INSERT INTO track_audio VALUES ('track_new', 'ru', 'original', 'p.mp3', 1, 2240400)`,
		// written before the migration: both populated, and a denoised sibling
		`INSERT INTO track_variants (track_id, language, title, audio_duration)
		   VALUES ('track_old', 'ru', 'Когда Господь улыбается', 2004741)`,
		`INSERT INTO track_audio VALUES ('track_old', 'ru', 'original', 'o.mp3', 1, 2004741)`,
		`INSERT INTO track_audio VALUES ('track_old', 'ru', 'clean', 'c.mp3', 1, 2004741)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	db.Close()

	h, err := sqlitedb.NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	repo := New(h)

	for _, tc := range []struct {
		id   string
		want int64
	}{
		{"track_new", 2240400},
		{"track_old", 2004741},
	} {
		tr := &Track{
			ID: tc.id, Titles: map[string]string{}, Durations: map[string]int64{},
			Transcripts: map[string]string{},
		}
		if err := repo.fillVariants(t.Context(), tr); err != nil {
			t.Fatalf("%s: %v", tc.id, err)
		}
		if got := tr.Duration("ru"); got != tc.want {
			t.Errorf("%s: duration = %d, want %d", tc.id, got, tc.want)
		}
	}
}

// A track with no audio row at all reports zero rather than failing.
func TestDurationAbsentWithoutAudio(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{
		`CREATE TABLE track_variants (track_id TEXT, language TEXT, title TEXT,
		   audio_duration INTEGER, transcript_path TEXT, outline TEXT)`,
		`CREATE TABLE track_audio (track_id TEXT, language TEXT, kind TEXT, path TEXT,
		   filesize INTEGER, duration INTEGER)`,
		`INSERT INTO track_variants (track_id, language, title) VALUES ('t', 'ru', 'Без аудио')`,
	} {
		if _, err := db.Exec(s); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	h, err := sqlitedb.NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	tr := &Track{ID: "t", Titles: map[string]string{}, Durations: map[string]int64{},
		Transcripts: map[string]string{}}
	if err := New(h).fillVariants(t.Context(), tr); err != nil {
		t.Fatal(err)
	}
	if got := tr.Duration("ru"); got != 0 {
		t.Errorf("duration = %d, want 0", got)
	}
}
