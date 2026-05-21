package attribution

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// --- in-memory fakes ---------------------------------------------------------

type fakeRepo struct {
	mu         sync.Mutex
	created    map[string]library.Attribution
	textAdds   []struct{ ID, Lang, Text string }
	refAdds    []struct {
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

func (f *fakeRepo) AttributionTextRemove(_ context.Context, id, lang, text string) error { return nil }
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
	mu          sync.Mutex
	calls       []struct{ From, To, Text string; Kind library.AttributionKind }
	failLang    string
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

// --- tests -------------------------------------------------------------------

func TestCreate_MintsCorrectIDPrefix(t *testing.T) {
	repo := newFakeRepo()
	uc := UseCase{
		Repo:    repo,
		Minter:  fakeMinter{tail: "abc123"},
		Langs:   []string{"ru"}, // no auto-translate to other langs
	}
	id, err := uc.Create(context.Background(), library.AttrQuestion, "ru", "что такое разум")
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

func TestCreate_RequiresText(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(context.Background(), library.AttrQuestion, "ru", ""); err == nil {
		t.Fatalf("expected error for empty text")
	}
}

func TestCreate_RequiresLanguage(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(context.Background(), library.AttrQuestion, "", "x"); err == nil {
		t.Fatalf("expected error for empty lang")
	}
}

func TestCreate_RejectsInvalidKind(t *testing.T) {
	uc := UseCase{Repo: newFakeRepo(), Minter: fakeMinter{tail: "x"}, Langs: []string{"ru"}}
	if _, err := uc.Create(context.Background(), "invalid", "ru", "x"); err == nil {
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
	id, err := uc.Create(context.Background(), library.AttrQuestion, "ru", "что такое разум")
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
	got, _, _ := repo.AttributionGet(context.Background(), id)
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
	id, err := uc.Create(context.Background(), library.AttrQuestion, "ru", "что такое разум")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, _, _ := repo.AttributionGet(context.Background(), id)
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
	_, err := uc.Create(context.Background(), library.AttrTopic, "ru", "вечность души")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(tr.calls) != 1 {
		t.Fatalf("expected 1 translate call, got %d", len(tr.calls))
	}
	if tr.calls[0].Kind != library.AttrTopic {
		t.Fatalf("expected kind=topic propagated to translator, got %v", tr.calls[0].Kind)
	}
}

func TestCreate_NoTranslator_OK(t *testing.T) {
	// Translator is optional; nil disables auto-translate but create still succeeds.
	repo := newFakeRepo()
	uc := UseCase{Repo: repo, Minter: fakeMinter{tail: "x"}, Langs: []string{"ru", "en"}}
	id, err := uc.Create(context.Background(), library.AttrQuestion, "ru", "x")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, _, _ := repo.AttributionGet(context.Background(), id)
	if len(got.Texts) != 1 || got.Texts["ru"][0] != "x" {
		t.Fatalf("expected single ru text, got %v", got.Texts)
	}
}
