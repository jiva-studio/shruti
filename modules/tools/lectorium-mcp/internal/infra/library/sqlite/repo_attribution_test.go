package sqlitelibrary

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

// openRaw opens the sqlite file directly (no migrations) so a test can seed a
// legacy schema before Open() runs its self-healing migration.
func openRaw(t *testing.T, path string) (*sql.DB, error) {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?_foreign_keys=ON", path)
	return sql.Open("sqlite3", dsn)
}

func openWithVerse(t *testing.T, verseID, sourceID, tokens string) *Repo {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")
	r, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })
	// Seed a verses table + one row so ref_add validation can find it.
	if _, err := r.db.ExecContext(ctx, `CREATE TABLE library_verses (
		id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT, text TEXT, transliteration TEXT)`); err != nil {
		t.Fatalf("create verses table: %v", err)
	}
	if verseID != "" {
		if _, err := r.db.ExecContext(ctx,
			`INSERT INTO library_verses (id, source_id, tokens, text, transliteration) VALUES (?,?,?,?,?)`,
			verseID, sourceID, tokens, "devanagari", "iast"); err != nil {
			t.Fatalf("seed verse: %v", err)
		}
	}
	if _, err := r.db.ExecContext(ctx, `CREATE TABLE library_verse_variants (
		verse_id TEXT, language TEXT, translation TEXT)`); err != nil {
		t.Fatalf("create variants table: %v", err)
	}
	if _, err := r.db.ExecContext(ctx, `CREATE TABLE library_documents (
		id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT, author_id TEXT, kind TEXT, date TEXT)`); err != nil {
		t.Fatalf("create docs table: %v", err)
	}
	if _, err := r.db.ExecContext(ctx, `CREATE TABLE library_document_variants (
		document_id TEXT, language TEXT, title TEXT, body TEXT)`); err != nil {
		t.Fatalf("create doc variants: %v", err)
	}
	return r
}

func TestAttributionCreate_BasicFlow(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	if err := r.AttributionCreate(ctx, "attribution_xyz", library.AttrPinned, "ru", "что такое разум"); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok, err := r.AttributionGet(ctx, "attribution_xyz")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.Kind != library.AttrPinned {
		t.Fatalf("kind mismatch: %v", got.Kind)
	}
	if len(got.Texts["ru"]) != 1 || got.Texts["ru"][0] != "что такое разум" {
		t.Fatalf("texts mismatch: %v", got.Texts)
	}
	if len(got.Refs) != 0 {
		t.Fatalf("expected empty refs, got %v", got.Refs)
	}
}

func TestAttributionTextAdd_MultipleVariants(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "что такое разум")
	if err := r.AttributionTextAdd(ctx, "attribution_a", "ru", "природа разума"); err != nil {
		t.Fatalf("add 2: %v", err)
	}
	if err := r.AttributionTextAdd(ctx, "attribution_a", "ru", "что значит buddhi"); err != nil {
		t.Fatalf("add 3: %v", err)
	}
	if err := r.AttributionTextAdd(ctx, "attribution_a", "en", "what is intelligence"); err != nil {
		t.Fatalf("add en: %v", err)
	}
	got, _, _ := r.AttributionGet(ctx, "attribution_a")
	if len(got.Texts["ru"]) != 3 {
		t.Fatalf("expected 3 ru variants, got %d: %v", len(got.Texts["ru"]), got.Texts["ru"])
	}
	if len(got.Texts["en"]) != 1 {
		t.Fatalf("expected 1 en variant, got %d", len(got.Texts["en"]))
	}
}

func TestAttributionTextAdd_DuplicateGracefulNoOp(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "что такое разум")
	// Same text again — INSERT OR IGNORE makes this a no-op.
	if err := r.AttributionTextAdd(ctx, "attribution_a", "ru", "что такое разум"); err != nil {
		t.Fatalf("dup add: %v", err)
	}
	got, _, _ := r.AttributionGet(ctx, "attribution_a")
	if len(got.Texts["ru"]) != 1 {
		t.Fatalf("expected dedupe (1 variant), got %d", len(got.Texts["ru"]))
	}
}

func TestAttributionRefAdd_VerseValidation(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "verse_xyz", "source_BG", "2.13")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "x")

	// Existing verse → OK.
	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "verse", TargetID: "verse_xyz",
	}); err != nil {
		t.Fatalf("ref_add existing verse: %v", err)
	}
	// Non-existing verse → error.
	err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "verse", TargetID: "verse_missing",
	})
	if !errors.Is(err, ErrRefTargetNotFound) {
		t.Fatalf("expected ErrRefTargetNotFound, got %v", err)
	}
}

func TestAttributionRefAdd_DocumentValidation(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO library_documents (id, source_id, tokens, author_id, kind, date) VALUES (?,?,?,?,?,?)`,
		"library_document_abc", "source_BG", "2.13", "author_p", "commentary", ""); err != nil {
		t.Fatalf("seed doc: %v", err)
	}
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "x")

	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "document", TargetID: "library_document_abc",
	}); err != nil {
		t.Fatalf("ref_add doc: %v", err)
	}
	err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "document", TargetID: "library_document_missing",
	})
	if !errors.Is(err, ErrRefTargetNotFound) {
		t.Fatalf("expected ErrRefTargetNotFound, got %v", err)
	}
}

func TestAttributionRefAdd_TitleValidation(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	// Seed a library_titles row (chapter heading) the title ref points at.
	if _, err := r.db.ExecContext(ctx, `CREATE TABLE library_titles (
		source_id TEXT, tokens TEXT, language TEXT, title TEXT)`); err != nil {
		t.Fatalf("create titles table: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO library_titles (source_id, tokens, language, title) VALUES (?,?,?,?)`,
		"source_SB", "7.5", "ru", "Махараджа Прахлада, святой сын Хираньякашипу"); err != nil {
		t.Fatalf("seed title: %v", err)
	}
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrBoost, "ru", "история Прахлады")

	// Existing chapter → OK; target stored as composite "source/tokens".
	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "title", TargetID: "source_SB/7.5",
	}); err != nil {
		t.Fatalf("ref_add existing title: %v", err)
	}
	got, _, _ := r.AttributionGet(ctx, "attribution_a")
	if len(got.Refs) != 1 || got.Refs[0].Kind != "title" || got.Refs[0].TargetID != "source_SB/7.5" {
		t.Fatalf("title ref not stored verbatim: %+v", got.Refs)
	}
	// Non-existing chapter → error.
	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "title", TargetID: "source_SB/99.9",
	}); !errors.Is(err, ErrRefTargetNotFound) {
		t.Fatalf("expected ErrRefTargetNotFound, got %v", err)
	}
	// Malformed composite (no '/') → validation error, not a panic.
	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "title", TargetID: "source_SB",
	}); err == nil {
		t.Fatalf("expected error for malformed title target_id")
	}
}

func TestRelaxAttributionRefKindCheck_LegacyDBAcceptsTitle(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "library.db")

	// Phase 1: build a legacy DB whose refs table still carries the old
	// CHECK (ref_kind IN ('verse','document')) — what a pre-feature
	// library.db looks like.
	legacy, err := openRaw(t, path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	for _, s := range []string{
		`CREATE TABLE library_attributions (id TEXT PRIMARY KEY, kind TEXT, created_at TEXT, updated_at TEXT)`,
		`CREATE TABLE library_attribution_refs (
			attribution_id TEXT NOT NULL,
			ref_kind       TEXT NOT NULL CHECK (ref_kind IN ('verse','document')),
			target_id      TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (attribution_id, ref_kind, target_id))`,
		`CREATE TABLE library_titles (source_id TEXT, tokens TEXT, language TEXT, title TEXT)`,
		`INSERT INTO library_titles (source_id, tokens, language, title) VALUES ('source_SB','7.5','ru','t')`,
	} {
		if _, err := legacy.ExecContext(ctx, s); err != nil {
			t.Fatalf("seed legacy: %v", err)
		}
	}
	_ = legacy.Close()

	// Phase 2: Open() runs the migration; the CHECK should be gone.
	r, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open (migrate): %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES ('attribution_a','topic','t','t')`,
	); err != nil {
		t.Fatalf("seed attribution: %v", err)
	}
	if err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "title", TargetID: "source_SB/7.5",
	}); err != nil {
		t.Fatalf("title ref on migrated legacy DB should succeed, got: %v", err)
	}
}

func TestAttributionRefAdd_InvalidKind(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "x")
	err := r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{
		Kind: "playlist", TargetID: "x",
	})
	if err == nil {
		t.Fatalf("expected error for invalid kind")
	}
}

func TestAttributionDelete_CascadesTextsAndRefs(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "verse_xyz", "source_BG", "2.13")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "x")
	_ = r.AttributionTextAdd(ctx, "attribution_a", "en", "y")
	_ = r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{Kind: "verse", TargetID: "verse_xyz"})

	if err := r.AttributionDelete(ctx, "attribution_a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	var n int
	if err := r.db.QueryRowContext(ctx, `SELECT count(*) FROM library_attribution_texts WHERE attribution_id='attribution_a'`).Scan(&n); err != nil {
		t.Fatalf("count texts: %v", err)
	}
	if n != 0 {
		t.Fatalf("cascade texts failed: %d remain", n)
	}
	if err := r.db.QueryRowContext(ctx, `SELECT count(*) FROM library_attribution_refs WHERE attribution_id='attribution_a'`).Scan(&n); err != nil {
		t.Fatalf("count refs: %v", err)
	}
	if n != 0 {
		t.Fatalf("cascade refs failed: %d remain", n)
	}
}

func TestAttributionList_FilterByKind(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_q1", library.AttrPinned, "ru", "вопрос про душу")
	_ = r.AttributionCreate(ctx, "attribution_q2", library.AttrPinned, "ru", "вопрос про карму")
	_ = r.AttributionCreate(ctx, "attribution_t1", library.AttrBoost, "ru", "вечность души")

	got, err := r.AttributionList(ctx, library.ListAttributionsOpts{Kind: library.AttrPinned})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 question rows, got %d", len(got))
	}
	got, err = r.AttributionList(ctx, library.ListAttributionsOpts{Kind: library.AttrBoost})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 topic row, got %d", len(got))
	}
}

func TestAttributionList_QueryLike(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "природа души")
	_ = r.AttributionCreate(ctx, "attribution_b", library.AttrPinned, "ru", "вопрос про карму")

	got, err := r.AttributionList(ctx, library.ListAttributionsOpts{Query: "душ"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 1 || got[0].ID != "attribution_a" {
		t.Fatalf("expected only attribution_a, got %+v", got)
	}
}

func TestAttribution_NotFoundErrors(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")

	if err := r.AttributionTextAdd(ctx, "absent", "ru", "x"); !errors.Is(err, ErrAttributionNotFound) {
		t.Fatalf("text_add expected ErrAttributionNotFound, got %v", err)
	}
	if err := r.AttributionRefAdd(ctx, "absent", library.AttributionRef{Kind: "verse", TargetID: "verse_x"}); !errors.Is(err, ErrAttributionNotFound) {
		t.Fatalf("ref_add expected ErrAttributionNotFound, got %v", err)
	}
	if err := r.AttributionDelete(ctx, "absent"); !errors.Is(err, ErrAttributionNotFound) {
		t.Fatalf("delete expected ErrAttributionNotFound, got %v", err)
	}
}

func TestAttributionTextRemove(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "v1")
	_ = r.AttributionTextAdd(ctx, "attribution_a", "ru", "v2")

	if err := r.AttributionTextRemove(ctx, "attribution_a", "ru", "v1"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	got, _, _ := r.AttributionGet(ctx, "attribution_a")
	if len(got.Texts["ru"]) != 1 || got.Texts["ru"][0] != "v2" {
		t.Fatalf("after remove expected only v2, got %v", got.Texts["ru"])
	}
}

func TestAttributionRefRemove(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "verse_xyz", "source_BG", "2.13")
	_ = r.AttributionCreate(ctx, "attribution_a", library.AttrPinned, "ru", "x")
	_ = r.AttributionRefAdd(ctx, "attribution_a", library.AttributionRef{Kind: "verse", TargetID: "verse_xyz"})

	if err := r.AttributionRefRemove(ctx, "attribution_a", library.AttributionRef{Kind: "verse", TargetID: "verse_xyz"}); err != nil {
		t.Fatalf("remove: %v", err)
	}
	got, _, _ := r.AttributionGet(ctx, "attribution_a")
	if len(got.Refs) != 0 {
		t.Fatalf("expected refs empty after remove, got %v", got.Refs)
	}
}

func TestAttributionFindByText(t *testing.T) {
	ctx := context.Background()
	r := openWithVerse(t, "", "", "")
	if err := r.AttributionCreate(ctx, "attribution_a", library.AttrBoost, "ru", "природа души"); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Exact (kind, lang, text) → found.
	id, found, err := r.AttributionFindByText(ctx, library.AttrBoost, "ru", "природа души")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if !found || id != "attribution_a" {
		t.Fatalf("expected found attribution_a, got found=%v id=%q", found, id)
	}

	// Same text, different kind → not found (kinds are distinct attributions).
	if _, found, _ := r.AttributionFindByText(ctx, library.AttrPinned, "ru", "природа души"); found {
		t.Fatalf("kind=pinned must not match a boost attribution")
	}

	// Different text → not found.
	if _, found, _ := r.AttributionFindByText(ctx, library.AttrBoost, "ru", "что-то ещё"); found {
		t.Fatalf("unexpected match for absent text")
	}

	// Different language → not found (text variant is per-language).
	if _, found, _ := r.AttributionFindByText(ctx, library.AttrBoost, "en", "природа души"); found {
		t.Fatalf("lang=en must not match a ru-only variant")
	}
}
