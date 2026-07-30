package sqlitecatalog

import (
	"context"
	"sync"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	glossary "github.com/jiva-studio/shruti/pipeline/glossary"
)

// FuzzyIndex builds one in-memory glossary.Glossary per dict kind on
// top of a Repo. Used by the metadata extractor's resolver to feed the
// LLM a small list of relevant candidates instead of dumping the whole
// dict.
//
// State is purely derived from catalog/current.db. After any dict
// mutation that should be reflected in resolves (CreateDict,
// UpdateDictLocale, DeleteDict, manual SQL edits, post-publish
// catalog refresh) call Rebuild. The index keeps the previous state
// available concurrently while a rebuild is in flight (RWMutex around
// the per-kind Glossary pointer).
//
// Trigram inputs:
//   - KindAuthor / KindLocation / KindTag → full_name
//   - KindSource                          → full_name (the long title;
//     short_name like "BG" is too short for trigram matching and is
//     handled exclusively via Repo.LookupIDByName exact match)
type FuzzyIndex struct {
	dict   catalogport.DictRepository
	mu     sync.RWMutex
	byKind map[catalog.Kind]*glossary.Glossary
}

func NewFuzzyIndex(dict catalogport.DictRepository) *FuzzyIndex {
	return &FuzzyIndex{
		dict:   dict,
		byKind: map[catalog.Kind]*glossary.Glossary{},
	}
}

// Match implements catalogport.DictFuzzyIndex.
func (f *FuzzyIndex) Match(ctx context.Context, kind catalog.Kind, query, language string,
	threshold float64, maxHints int) ([]catalogport.DictCandidate, error) {

	f.mu.RLock()
	g := f.byKind[kind]
	f.mu.RUnlock()
	if g == nil {
		// First call for this kind — lazy-build.
		if err := f.rebuildKind(ctx, kind); err != nil {
			return nil, err
		}
		f.mu.RLock()
		g = f.byKind[kind]
		f.mu.RUnlock()
	}
	if g == nil {
		return nil, nil
	}

	hints := g.Match(query, language, threshold, maxHints)
	if len(hints) == 0 {
		return nil, nil
	}

	// glossary.Hint carries Canonical (the full_name in `language`) but
	// not the dict id. Reverse-lookup by name to attach ids — this is
	// O(N) per hint but N is small (maxHints ≤ ~20 in practice).
	out := make([]catalogport.DictCandidate, 0, len(hints))
	for _, h := range hints {
		id, ok, err := f.dict.LookupIDByName(ctx, kind, h.Canonical, language)
		if err != nil {
			return nil, err
		}
		if !ok {
			// Race: catalog edited between Glossary build and Match.
			// Skip, will be picked up on next Rebuild.
			continue
		}
		out = append(out, catalogport.DictCandidate{
			ID:    id,
			Name:  h.Canonical,
			Score: h.Score,
		})
	}
	return out, nil
}

// Rebuild reloads every kind's index from scratch. Cheap on small
// dicts (few hundred entries × 2 locales).
func (f *FuzzyIndex) Rebuild(ctx context.Context) error {
	for _, kind := range []catalog.Kind{catalog.KindAuthor, catalog.KindLocation, catalog.KindSource, catalog.KindTag} {
		if err := f.rebuildKind(ctx, kind); err != nil {
			return err
		}
	}
	return nil
}

func (f *FuzzyIndex) rebuildKind(ctx context.Context, kind catalog.Kind) error {
	entries, err := f.dict.ListDict(ctx, kind, catalog.ListOpts{Limit: 100000})
	if err != nil {
		return err
	}
	gentries := make([]glossary.Entry, 0, len(entries))
	for _, e := range entries {
		canonical := map[string]string{}
		// trigram-match always uses full_name (even for sources — short_name
		// is too short for trigrams and resolved by LookupIDByName instead).
		for lang, name := range e.Names {
			if name != "" {
				canonical[lang] = name
			}
		}
		if len(canonical) == 0 {
			continue
		}
		gentries = append(gentries, glossary.Entry{
			Canonical: canonical,
			// Category/Hint not used in resolver — just carry empty.
		})
	}
	g := glossary.Build(gentries)
	f.mu.Lock()
	f.byKind[kind] = g
	f.mu.Unlock()
	return nil
}

// Compile-time interface assertion.
var _ catalogport.DictFuzzyIndex = (*FuzzyIndex)(nil)
