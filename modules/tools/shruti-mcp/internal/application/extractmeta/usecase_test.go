package extractmeta

import (
	"context"
	"errors"
	"testing"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// fakeCatalog is the minimum DictRepository surface resolveOne touches:
// LookupIDByName (exact match step 1) + GetDict (LLM-result name lookup
// step 4) + CreateDict (auto-create step 5) + UpdateDictLocale (locale
// backfill). Other methods stay on the embedded interface and panic if
// called — surfaces test misuse fast.
type fakeCatalog struct {
	catalogport.DictRepository
	byName       map[string]string                  // "kind|name|lang" → id
	entries      map[string]catalog.DictEntry        // id → entry
	createdIDs   []string
	updatedLocs  []updateLocaleArgs
}

type updateLocaleArgs struct {
	id, lang, full, short string
}

func (c *fakeCatalog) LookupIDByName(_ context.Context, kind catalog.Kind, name, lang string) (string, bool, error) {
	id, ok := c.byName[string(kind)+"|"+name+"|"+lang]
	return id, ok, nil
}
func (c *fakeCatalog) GetDict(_ context.Context, _ catalog.Kind, id string) (catalog.DictEntry, bool, error) {
	e, ok := c.entries[id]
	return e, ok, nil
}
func (c *fakeCatalog) CreateDict(_ context.Context, kind catalog.Kind, e catalog.DictEntry) (string, error) {
	c.createdIDs = append(c.createdIDs, e.Id)
	c.entries[e.Id] = e
	for lang, name := range e.Names {
		c.byName[string(kind)+"|"+name+"|"+lang] = e.Id
	}
	return e.Id, nil
}
func (c *fakeCatalog) UpdateDictLocale(_ context.Context, kind catalog.Kind, id, lang, full, short string) error {
	c.updatedLocs = append(c.updatedLocs, updateLocaleArgs{id, lang, full, short})
	e, ok := c.entries[id]
	if !ok {
		e = catalog.DictEntry{Id: id, Names: map[string]string{}}
	}
	if e.Names == nil {
		e.Names = map[string]string{}
	}
	e.Names[lang] = full
	c.entries[id] = e
	c.byName[string(kind)+"|"+full+"|"+lang] = id
	return nil
}
func (c *fakeCatalog) ListDict(_ context.Context, _ catalog.Kind, _ catalog.ListOpts) ([]catalog.DictEntry, error) {
	return nil, nil
}

// fakeFuzzy returns canned candidates per (kind,query,lang). nil → empty.
type fakeFuzzy struct {
	catalogport.DictFuzzyIndex
	byKey map[string][]catalogport.DictCandidate
}

func (f *fakeFuzzy) Match(_ context.Context, kind catalog.Kind, query, lang string,
	_ float64, _ int,
) ([]catalogport.DictCandidate, error) {
	return f.byKey[string(kind)+"|"+query+"|"+lang], nil
}

// fakeResolver returns whatever's pre-canned for a (kind,query) tuple. If
// nothing pre-canned, returns ConfNone (so resolveOne auto-creates).
type fakeResolver struct {
	answers map[string]catalogport.ResolveResponse
	calls   int
}

func (r *fakeResolver) Name() string { return "fake" }
func (r *fakeResolver) Resolve(_ context.Context, req catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	r.calls++
	if v, ok := r.answers[string(req.Kind)+"|"+req.Query]; ok {
		return v, nil
	}
	return catalogport.ResolveResponse{Confidence: catalogport.ConfNone, Provider: "fake"}, nil
}

// fakeMinter mints sequential test ids.
type fakeMinter struct{ n int }

func (m *fakeMinter) MintTail() string {
	m.n++
	return string(rune('a' - 1 + m.n))
}

// newUC wires a UseCase with all the fakes a resolveOne test needs.
func newUC() (*UseCase, *fakeCatalog, *fakeResolver) {
	cat := &fakeCatalog{
		byName:  map[string]string{},
		entries: map[string]catalog.DictEntry{},
	}
	rsv := &fakeResolver{answers: map[string]catalogport.ResolveResponse{}}
	uc := &UseCase{
		Catalog:         cat,
		Resolver:        rsv,
		FuzzyIndex:      &fakeFuzzy{byKey: map[string][]catalogport.DictCandidate{}},
		Minter:          &fakeMinter{},
		DefaultLanguage: "en",
	}
	return uc, cat, rsv
}

func TestResolveOneExactMatchSkipsLLM(t *testing.T) {
	uc, cat, rsv := newUC()
	cat.byName["author|Prabhupada|en"] = "author_pra"

	resp, err := uc.resolveOne(context.Background(), catalog.KindAuthor, "Prabhupada", "en")
	if err != nil {
		t.Fatal(err)
	}
	if resp.MatchedID != "author_pra" {
		t.Errorf("MatchedID = %q, want author_pra", resp.MatchedID)
	}
	if resp.Confidence != catalogport.ConfExact {
		t.Errorf("Confidence = %q, want exact", resp.Confidence)
	}
	if resp.MatchedName != "Prabhupada" {
		t.Errorf("MatchedName = %q, want Prabhupada", resp.MatchedName)
	}
	if rsv.calls != 0 {
		t.Errorf("LLM resolver hit %d times, want 0 (exact-match must short-circuit)", rsv.calls)
	}
}

// runMemo is sync.Map on a value-receiver — copies don't share state, so
// the memo only deduplicates within a single Run() walk (one track's
// author + location + refs). Cross-Run dedup isn't part of the contract,
// so there's no point pinning it here.

func TestResolveOneAutoCreateOnNoMatch(t *testing.T) {
	uc, cat, rsv := newUC()
	// LLM returns ConfNone → auto-create path.
	rsv.answers["location|Atlantis"] = catalogport.ResolveResponse{
		Confidence: catalogport.ConfNone,
		Provider:   "fake",
	}
	resp, err := uc.resolveOne(context.Background(), catalog.KindLocation, "Atlantis", "en")
	if err != nil {
		t.Fatal(err)
	}
	if resp.MatchedID == "" {
		t.Fatal("MatchedID empty after auto-create")
	}
	if resp.MatchedName != "Atlantis" {
		t.Errorf("MatchedName = %q, want Atlantis", resp.MatchedName)
	}
	if resp.Provider != "auto-create" {
		t.Errorf("Provider = %q, want auto-create", resp.Provider)
	}
	if len(cat.createdIDs) != 1 {
		t.Errorf("expected 1 CreateDict call, got %d", len(cat.createdIDs))
	}
}

func TestResolveOneLLMMatchedSetsMatchedName(t *testing.T) {
	uc, cat, rsv := newUC()
	rsv.answers["author|Prabhupāda"] = catalogport.ResolveResponse{
		MatchedID:  "author_pra",
		Confidence: catalogport.ConfHigh,
		Provider:   "fake",
	}
	cat.entries["author_pra"] = catalog.DictEntry{
		Id: "author_pra", Names: map[string]string{"en": "A.C. Bhaktivedanta Swami Prabhupada"},
	}
	resp, err := uc.resolveOne(context.Background(), catalog.KindAuthor, "Prabhupāda", "en")
	if err != nil {
		t.Fatal(err)
	}
	if resp.MatchedID != "author_pra" {
		t.Errorf("MatchedID = %q", resp.MatchedID)
	}
	if resp.MatchedName != "A.C. Bhaktivedanta Swami Prabhupada" {
		t.Errorf("MatchedName = %q (want canonical full_name from GetDict)", resp.MatchedName)
	}
}

func TestResolveOneLLMMatchedSourceUsesShortName(t *testing.T) {
	uc, cat, rsv := newUC()
	rsv.answers["source|Bhagavad Gita"] = catalogport.ResolveResponse{
		MatchedID:  "source_bg",
		Confidence: catalogport.ConfHigh,
		Provider:   "fake",
	}
	cat.entries["source_bg"] = catalog.DictEntry{
		Id:        "source_bg",
		Names:     map[string]string{"en": "Bhagavad-gita"},
		ShortName: map[string]string{"en": "BG"},
	}
	resp, err := uc.resolveOne(context.Background(), catalog.KindSource, "Bhagavad Gita", "en")
	if err != nil {
		t.Fatal(err)
	}
	if resp.MatchedName != "BG" {
		t.Errorf("MatchedName = %q, want BG (source resolves to short_name)", resp.MatchedName)
	}
}

func TestResolveOneLLMErrorPropagates(t *testing.T) {
	uc, _, rsv := newUC()
	want := errors.New("LLM exploded")
	// Replace Resolver with one that errors.
	uc.Resolver = errResolver{err: want}
	_ = rsv
	_, err := uc.resolveOne(context.Background(), catalog.KindAuthor, "Anyone", "en")
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
}

type errResolver struct{ err error }

func (errResolver) Name() string { return "err" }
func (e errResolver) Resolve(_ context.Context, _ catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	return catalogport.ResolveResponse{}, e.err
}

func TestEntryLanguageFallbackToDefault(t *testing.T) {
	uc, _, _ := newUC()
	if got := uc.entryLanguage(nil); got != "en" {
		t.Errorf("nil → %q, want en (DefaultLanguage)", got)
	}
	if got := uc.entryLanguage([]string{}); got != "en" {
		t.Errorf("empty → %q, want en", got)
	}
	if got := uc.entryLanguage([]string{"ru", "en"}); got != "ru" {
		t.Errorf("first non-empty wins → %q, want ru", got)
	}
}
