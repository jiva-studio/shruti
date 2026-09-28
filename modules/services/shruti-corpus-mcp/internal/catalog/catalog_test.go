package catalog

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/sqlitedb"
)

// openCatalog writes the published track tables plus stmts into a file and
// opens a repo over it.
func openCatalog(t *testing.T, stmts ...string) *Repo {
	t.Helper()
	path := filepath.Join(t.TempDir(), "catalog.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	schema := []string{
		`CREATE TABLE tracks (id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
		   date TEXT, hidden INTEGER NOT NULL DEFAULT 0, contributor_user_id TEXT)`,
		`CREATE TABLE track_variants (track_id TEXT, language TEXT, title TEXT,
		   audio_duration INTEGER, transcript_path TEXT, outline TEXT, description TEXT,
		   PRIMARY KEY (track_id, language))`,
		`CREATE TABLE track_audio (track_id TEXT, language TEXT, kind TEXT, path TEXT,
		   filesize INTEGER, duration INTEGER, PRIMARY KEY (track_id, language, kind))`,
		`CREATE TABLE track_tags (track_id TEXT, tag_id TEXT)`,
		`CREATE TABLE track_references (track_id TEXT, ref_idx INTEGER, source_id TEXT, tokens TEXT)`,
	}
	for _, s := range append(schema, stmts...) {
		if _, err := db.ExecContext(t.Context(), s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	h, err := sqlitedb.NewHandle(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	})
	return New(h)
}

// A catalog written by the current pipeline carries the duration in
// track_audio and leaves track_variants.audio_duration — the column the
// per-version audio model replaced — empty. Reading that column would return 0
// for every such track.
func TestDurationComesFromTrackAudio(t *testing.T) {
	repo := openCatalog(t,
		`INSERT INTO tracks (id, date) VALUES ('track_new', '2025-12-14'), ('track_old', '1974-11-12'), ('track_mute', NULL)`,
		`INSERT INTO track_variants (track_id, language, title, audio_duration)
		   VALUES ('track_new', 'ru', 'Сага о слоне Кешаве', NULL)`,
		`INSERT INTO track_audio VALUES ('track_new', 'ru', 'original', 'p.mp3', 1, 2240400)`,
		`INSERT INTO track_variants (track_id, language, title, audio_duration)
		   VALUES ('track_old', 'ru', 'Когда Господь улыбается', 2004741)`,
		`INSERT INTO track_audio VALUES ('track_old', 'ru', 'original', 'o.mp3', 1, 2004741)`,
		`INSERT INTO track_audio VALUES ('track_old', 'ru', 'clean', 'c.mp3', 1, 2004741)`,
		`INSERT INTO track_variants (track_id, language, title) VALUES ('track_mute', 'ru', 'Без аудио')`,
	)
	for id, want := range map[string]int64{"track_new": 2240400, "track_old": 2004741, "track_mute": 0} {
		tr, err := repo.GetTrack(t.Context(), id)
		if err != nil || tr == nil {
			t.Fatalf("%s: %v %v", id, tr, err)
		}
		if got := tr.Duration("ru"); got != want {
			t.Errorf("%s: duration = %d, want %d", id, got, want)
		}
	}
}

func TestGetTracksAssemblesVisibleTracksInOnePass(t *testing.T) {
	repo := openCatalog(t,
		`INSERT INTO tracks (id, author_id, date, hidden) VALUES ('t1', 'a1', '1974-01-01', 0), ('t2', NULL, NULL, 1)`,
		`INSERT INTO track_variants (track_id, language, title, transcript_path, outline) VALUES
		   ('t1', 'ru', 'Один', 'public/tracks/t1/transcripts/ru.json', '[]'), ('t1', 'en', 'One', NULL, NULL)`,
		`INSERT INTO track_tags VALUES ('t1', 'tag_interview')`,
		`INSERT INTO track_references VALUES ('t1', 1, 'source_bg', '2.13'), ('t1', 0, 'source_sb', '1.1')`,
	)
	got, err := repo.GetTracks(t.Context(), []string{"t1", "t2", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("hidden or missing tracks returned: %v", got)
	}
	tr := got["t1"]
	if tr.Kind() != "conversation" || !tr.HasOutline || tr.Title("en") != "One" ||
		!reflect.DeepEqual(tr.Languages, []string{"en", "ru"}) {
		t.Fatalf("assembled %+v", tr)
	}
	if !tr.Cites("source_bg", "2.13") || !tr.Cites("source_sb", "") || tr.Cites("source_bg", "2") {
		t.Fatalf("Cites over refs %v", tr.Refs)
	}
	if tr.Refs[0].SourceID != "source_sb" {
		t.Fatalf("references out of ref_idx order: %v", tr.Refs)
	}
}

func TestListTracksFiltersAndEnrichesEachRow(t *testing.T) {
	repo := openCatalog(t,
		`INSERT INTO tracks (id, date) VALUES ('t1', '1974-01-01'), ('t2', '1975-01-01'), ('t3', '1976-01-01')`,
		`INSERT INTO track_variants (track_id, language, title) VALUES ('t1', 'en', 'A'), ('t2', 'en', 'B'), ('t3', 'en', 'C')`,
		`INSERT INTO track_tags VALUES ('t2', 'tag_morning_walk')`,
		`INSERT INTO track_references VALUES ('t1', 0, 'source_bg', '2.13'), ('t2', 0, 'source_bg', '2.20'), ('t3', 0, 'source_bg', '3.1')`,
	)
	got, err := repo.ListTracks(t.Context(), ListFilter{SourceID: "source_bg", Tokens: "2", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "t2" || got[1].ID != "t1" {
		t.Fatalf("chapter 2, date desc: %v", got)
	}
	if got[0].Kind() != "conversation" || got[1].Title("en") != "A" {
		t.Fatalf("rows not enriched: %+v %+v", got[0], got[1])
	}
	lectures, err := repo.ListTracks(t.Context(), ListFilter{Kind: "lecture", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(lectures) != 2 {
		t.Fatalf("lecture filter kept %d tracks, want 2", len(lectures))
	}
}
