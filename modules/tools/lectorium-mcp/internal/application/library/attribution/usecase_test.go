package attribution

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

// --- in-memory fakes ---------------------------------------------------------

type fakeRepo struct {
	mu       sync.Mutex
	created  map[string]library.Attribution
	textAdds []struct{ ID, Lang, Text string }
	noteSets []struct{ ID, Lang, Note string }
	refAdds  []struct {
		ID  string
		Ref library.AttributionRef
	}
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{created: map[string]library.Attribution{}}
}

func (f *fakeRepo) AttributionCreate(_ context.Context, id string, kind library.AttributionKind, lang, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created[id] = library.Attribution{
		ID: id, Kind: kind,
		Texts: map[string][]string{lang: {text}},
	}
	return nil
}

func (f *fakeRepo) AttributionFindByText(_ context.Context, kind library.AttributionKind, lang, text string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, a := range f.created {
		if a.Kind != kind {
			continue
		}
		for _, t := range a.Texts[lang] {
			if t == text {
				return id, true, nil
			}
		}
	}
	return "", false, nil
}

func (f *fakeRepo) AttributionGet(_ context.Context, id string) (library.Attribution, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.created[id]
	return a, ok, nil
}

func (f *fakeRepo) AttributionList(_ context.Context, _ library.ListAttributionsOpts) ([]library.Attribution, error) {
	return nil, nil
}

func (f *fakeRepo) AttributionTextAdd(_ context.Context, id, lang, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.textAdds = append(f.textAdds, struct{ ID, Lang, Text string }{id, lang, text})
	a, ok := f.created[id]
	if !ok {
		return errors.New("not found")
	}
	a.Texts[lang] = append(a.Texts[lang], text)
	f.created[id] = a
	return nil
}

func (f *fakeRepo) AttributionTextRemove(_ context.Context, _, _, _ string) error { return nil }
func (f *fakeRepo) AttributionNoteSet(_ context.Context, id, lang, note string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.noteSets = append(f.noteSets, struct{ ID, Lang, Note string }{id, lang, note})
	a, ok := f.created[id]
	if !ok {
		return errors.New("not found")
	}
	if a.Notes == nil {
		a.Notes = map[string]string{}
	}
	a.Notes[lang] = note
	f.created[id] = a
	return nil
}
func (f *fakeRepo) AttributionNoteRemove(_ context.Context, id, lang string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if a, ok := f.created[id]; ok {
		delete(a.Notes, lang)
		f.created[id] = a
	}
	return nil
}
func (f *fakeRepo) AttributionRefAdd(_ context.Context, id string, ref library.AttributionRef) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refAdds = append(f.refAdds, struct {
		ID  string
		Ref library.AttributionRef
	}{id, ref})
	return nil
}
func (f *fakeRepo) AttributionRefRemove(_ context.Context, _ string, _ library.AttributionRef) error {
	return nil
}
func (f *fakeRepo) AttributionDelete(_ context.Context, _ string) error { return nil }

type fakeTranslator struct {
	mu    sync.Mutex
	calls []struct {
		From, To, Text string
		Kind           library.AttributionKind
	}
	failLang     string
	prefixByLang map[string]string // toLang → prefix to add to text (simulates translation)
}

func (t *fakeTranslator) Translate(_ context.Context, text, from, to string, kind library.AttributionKind) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.calls = append(t.calls, struct {
		From, To, Text string
		Kind           library.AttributionKind
	}{from, to, text, kind})
	if t.failLang != "" && to == t.failLang {
		return "", errors.New("simulated failure")
	}
	prefix := t.prefixByLang[to]
	if prefix == "" {
		prefix = "[" + to + "] "
	}
	return prefix + text, nil
}

type fakeMinter struct{ tail string }

func (m fakeMinter) MintTail() string { return m.tail }

// seqMinter returns a distinct tail per call (mint1, mint2, …) so a test can
// tell a reused id apart from a freshly-minted one.
type seqMinter struct{ n int }

func (m *seqMinter) MintTail() string { m.n++; return "mint" + strconv.Itoa(m.n) }

// --- tests -------------------------------------------------------------------

func TestCreate_MintsCorrectIDPrefix(t *testing.T) {
	repo := newFakeRepo()
	uc := UseCase{
		Repo:   repo,
		Minter: fakeMinter{tail: "abc123"},
		Langs:  []string{"ru"}, // no auto-translate to other langs
	}
	id, err := uc.Create(t.Context(), library.AttrPinned, "ru", "что такое разум", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.HasPrefix(id, "attribution_") {
		t.Fatalf("id prefix mismatch: %q", id)
	}
	if id != "attribution_abc123" {
		t.Fatalf("id mismatch: %q", id)
	}
}

func TestCreate_IdempotentOnSameText(t *testing.T) {
	repo := newFakeRepo()
	uc := UseCase{
		Repo:   repo,
		Minter: &seqMinter{}, // distinct tail per mint so dupes are detectable
		Langs:  []string{"ru"},
	}
	id1, err := uc.Create(t.Context(), library.AttrBoost, "ru", "природа души", "")
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	// Second create with the same (kind, lang, text) must reuse the existing
	// attribution, not mint a duplicate — this is what lets a bulk import
	// re-run safely without external checkpoints.
	id2, err := uc.Create(t.Context(), library.AttrBoost, "ru", "природа души", "")
	if err != nil {
		t.Fatalf("second create: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("expected same id on repeat create, got %q then %q", id1, id2)
	}
	if len(repo.created) != 1 {
		t.Fatalf("expected exactly 1 attribution row, got %d", len(repo.created))
	}
	// A different kind with the same text IS a distinct attribution.
	id3, err := uc.Create(t.Context(), library.AttrPinned, "ru", "природа души", "")
	if err != nil {
		t.Fatalf("third create: %v", err)
	}
	if id3 == id1 {
		t.Fatalf("different kind must not collide with existing attribution")
	}
}

func TestCreate_RequiresText(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(t.Context(), library.AttrPinned, "ru", "", ""); err == nil {
		t.Fatalf("expected error for empty text")
	}
}

func TestCreate_RequiresLanguage(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(t.Context(), library.AttrPinned, "", "x", ""); err == nil {
		t.Fatalf("expected error for empty lang")
	}
}

func TestCreate_RejectsInvalidKind(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(t.Context(), "invalid", "ru", "x", ""); err == nil {
		t.Fatalf("expected error for invalid kind")
	}
}

func TestCreate_AutoTranslate_AllLangsCovered(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en", "hi"},
	}
	id, err := uc.Create(t.Context(), library.AttrPinned, "ru", "что такое разум", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Translator called for en and hi (not for source ru).
	if len(tr.calls) != 2 {
		t.Fatalf("expected 2 translate calls, got %d (%+v)", len(tr.calls), tr.calls)
	}
	toLangs := map[string]bool{tr.calls[0].To: true, tr.calls[1].To: true}
	if !toLangs["en"] || !toLangs["hi"] {
		t.Fatalf("expected calls for en+hi, got %v", toLangs)
	}
	// Repo got text_add for each translated lang.
	got, _, _ := repo.AttributionGet(t.Context(), id)
	if len(got.Texts) != 3 {
		t.Fatalf("expected 3 langs in repo, got %v", got.Texts)
	}
}

func TestCreate_TranslateFailure_NonFatal(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{failLang: "hi"}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en", "hi"},
	}
	id, err := uc.Create(t.Context(), library.AttrPinned, "ru", "что такое разум", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	// ru + en succeeded; hi failed silently
	if _, has := got.Texts["ru"]; !has {
		t.Fatalf("ru missing")
	}
	if _, has := got.Texts["en"]; !has {
		t.Fatalf("en missing (translation should have succeeded)")
	}
	if _, has := got.Texts["hi"]; has {
		t.Fatalf("hi should be absent (translation failed)")
	}
}

func TestCreate_TopicKind_PassesKindToTranslator(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en"},
	}
	_, err := uc.Create(t.Context(), library.AttrBoost, "ru", "вечность души", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(tr.calls) != 1 {
		t.Fatalf("expected 1 translate call, got %d", len(tr.calls))
	}
	if tr.calls[0].Kind != library.AttrBoost {
		t.Fatalf("expected kind=boost propagated to translator, got %v", tr.calls[0].Kind)
	}
}

func TestCreate_NoTranslator_OK(t *testing.T) {
	// Translator is optional; nil disables auto-translate but create still succeeds.
	repo := newFakeRepo()
	uc := UseCase{Repo: repo, Minter: fakeMinter{tail: "x"}, Langs: []string{"ru", "en"}}
	id, err := uc.Create(t.Context(), library.AttrPinned, "ru", "x", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	if len(got.Texts) != 1 || got.Texts["ru"][0] != "x" {
		t.Fatalf("expected single ru text, got %v", got.Texts)
	}
}

func TestCreate_MemoryWithNote_SetsAndTranslatesNote(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en", "hi"},
	}
	id, err := uc.Create(t.Context(), library.AttrMemory, "ru", "структура гиты", "Гита делится на три части.")
	if err != nil {
		t.Fatalf("create memory: %v", err)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	// Note set in source + translated into en and hi.
	if got.Notes["ru"] != "Гита делится на три части." {
		t.Fatalf("ru note mismatch: %q", got.Notes["ru"])
	}
	if got.Notes["en"] == "" || got.Notes["hi"] == "" {
		t.Fatalf("expected translated notes for en and hi, got %v", got.Notes)
	}
	// The note translation used the memory prompt kind.
	memCalls := 0
	for _, c := range tr.calls {
		if c.Kind == library.AttrMemory {
			memCalls++
		}
	}
	if memCalls != 2 { // en + hi
		t.Fatalf("expected 2 memory-kind translate calls, got %d", memCalls)
	}
}

func TestNoteTranslate_FillsMissingOnly(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru"}, // create only lands the ru note
	}
	id, err := uc.Create(t.Context(), library.AttrMemory, "ru", "история арджуны", "Арджуна и Агни.")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	n, err := uc.NoteTranslate(t.Context(), "ru", "en", []string{id})
	if err != nil {
		t.Fatalf("note_translate: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 note translated, got %d", n)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	if got.Notes["en"] == "" {
		t.Fatalf("expected en note written")
	}

	// Second run is a no-op — never overwrites the existing en note.
	n, err = uc.NoteTranslate(t.Context(), "ru", "en", []string{id})
	if err != nil {
		t.Fatalf("note_translate 2: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 on re-run (en already exists), got %d", n)
	}
}

func TestTextAdd_AutoTranslatesIntoOtherLangs(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en", "hi"},
	}
	id, err := uc.Create(t.Context(), library.AttrMemory, "ru", "дхарма-йуддха", "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	before := len(tr.calls)

	if err := uc.TextAdd(t.Context(), id, "ru", "можно ли преданному воевать", false); err != nil {
		t.Fatalf("text_add: %v", err)
	}

	// One translate call per non-source language.
	if got := len(tr.calls) - before; got != 2 {
		t.Fatalf("expected 2 translate calls for the added trigger, got %d", got)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	for _, lang := range []string{"ru", "en", "hi"} {
		if len(got.Texts[lang]) != 2 {
			t.Fatalf("lang %s: expected 2 triggers, got %v", lang, got.Texts[lang])
		}
	}
}

func TestTextAdd_SkipTranslate(t *testing.T) {
	repo := newFakeRepo()
	tr := &fakeTranslator{}
	uc := UseCase{
		Repo:       repo,
		Translator: tr,
		Minter:     fakeMinter{tail: "x"},
		Langs:      []string{"ru", "en"},
	}
	id, _ := uc.Create(t.Context(), library.AttrBoost, "ru", "война", "")
	before := len(tr.calls)

	if err := uc.TextAdd(t.Context(), id, "ru", "агрессия", true); err != nil {
		t.Fatalf("text_add: %v", err)
	}

	if got := len(tr.calls) - before; got != 0 {
		t.Fatalf("skip_translate=true still called the translator %d times", got)
	}
	got, _, _ := repo.AttributionGet(t.Context(), id)
	if len(got.Texts["en"]) != 1 {
		t.Fatalf("en should keep only the create-time variant, got %v", got.Texts["en"])
	}
}

func TestTextAdd_NoTranslator_OK(t *testing.T) {
	repo := newFakeRepo()
	uc := UseCase{Repo: repo, Minter: fakeMinter{tail: "x"}, Langs: []string{"ru", "en"}}
	id, _ := uc.Create(t.Context(), library.AttrPinned, "ru", "вопрос", "")
	if err := uc.TextAdd(t.Context(), id, "ru", "ещё вопрос", false); err != nil {
		t.Fatalf("text_add without translator: %v", err)
	}
}
