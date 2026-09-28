package library

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/sqlitedb"
)

func openLibrary(t *testing.T, stmts ...string) *Repo {
	t.Helper()
	path := filepath.Join(t.TempDir(), "library.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	schema := []string{
		`CREATE TABLE library_verses (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, tokens TEXT NOT NULL,
		   text TEXT, transliteration TEXT, audio_path TEXT)`,
		`CREATE TABLE library_verse_translations (id TEXT PRIMARY KEY, verse_id TEXT NOT NULL,
		   language TEXT NOT NULL, translation TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'canonical',
		   author_id TEXT, note TEXT, label TEXT)`,
		`CREATE TABLE library_verse_transliterations (verse_id TEXT, language TEXT, text TEXT)`,
		`CREATE TABLE library_documents (id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT, author_id TEXT, kind TEXT, date TEXT)`,
		`CREATE TABLE library_document_variants (document_id TEXT, language TEXT, title TEXT, body TEXT)`,
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

func TestListVersesCollapsesMergesAndSkipsSummaries(t *testing.T) {
	repo := openLibrary(t,
		`INSERT INTO library_verses (id, source_id, tokens, text) VALUES
		   ('v10', 'bg', '1.10', 'x'), ('v2', 'bg', '1.2', 'y'), ('v0', 'bg', '1.0', ''),
		   ('v16', 'bg', '1.16', 'merged'), ('v17', 'bg', '1.17', 'merged'), ('v18', 'bg', '1.18', 'merged'),
		   ('v21', 'bg', '2.1', 'z')`,
		`INSERT INTO library_verse_translations (id, verse_id, language, translation, kind) VALUES
		   ('t1', 'v2', 'en', 'two', 'canonical'), ('t2', 'v2', 'en', 'alt', 'alt'), ('t3', 'v16', 'ru', 'слитый', 'canonical')`,
	)
	items, err := repo.ListVerses(t.Context(), "bg", "1")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, it := range items {
		got = append(got, it.Tokens+"|"+it.Covers+"|"+it.Translations["en"]+it.Translations["ru"])
	}
	want := []string{"1.2||two", "1.10||", "1.16|1.16-1.18|слитый"}
	if len(got) != len(want) {
		t.Fatalf("items %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("items %v, want %v", got, want)
		}
	}
	v, err := repo.GetByID(t.Context(), "v17")
	if err != nil {
		t.Fatal(err)
	}
	if covers, err := repo.VerseCovers(t.Context(), v); err != nil || covers != "1.16-1.18" {
		t.Fatalf("VerseCovers = %q %v", covers, err)
	}
	if tr, err := repo.Transliteration(t.Context(), "v17", "ru", "iast"); err != nil || tr != "iast" {
		t.Fatalf("Transliteration fallback = %q %v", tr, err)
	}
}

func TestDocumentsAndStats(t *testing.T) {
	repo := openLibrary(t,
		`INSERT INTO library_verses (id, source_id, tokens, text) VALUES ('v1', 'sb', '1.1.1', 'a'), ('v0', 'sb', '1.1.0', '')`,
		`INSERT INTO library_documents VALUES ('d1', 'sb', '1.1.1', 'a1', 'commentary', NULL), ('d2', 'sb', '1.1.1', 'a1', 'letter', '1970')`,
		`INSERT INTO library_document_variants VALUES ('d1', 'en', 'P', 'body1'), ('d2', 'ru', NULL, 'body2')`,
	)
	docs, err := repo.ListDocuments(t.Context(), DocFilter{SourceID: "sb", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 || docs[0].Bodies["en"].Body != "body1" || docs[1].Bodies["ru"].Body != "body2" || docs[1].Date != "1970" {
		t.Fatalf("documents %+v %+v", docs[0], docs[1])
	}
	if d, err := repo.GetDocument(t.Context(), "missing"); d != nil || err != nil {
		t.Fatalf("missing document: %v %v", d, err)
	}
	st, err := repo.Stats(t.Context(), "sb")
	if err != nil {
		t.Fatal(err)
	}
	if st != (SourceStats{TokenScheme: "canto.chapter.verse", VerseCount: 1, HasCommentary: true}) {
		t.Fatalf("stats %+v", st)
	}
}
