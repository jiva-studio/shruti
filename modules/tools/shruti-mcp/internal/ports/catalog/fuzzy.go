package catalogport

import (
	"context"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// DictFuzzyIndex narrows the LLM resolver's candidate list down to the
// few dict entries whose canonical name has high trigram-overlap with
// the raw query. Replaces the old "dump top-200 entries unfiltered"
// path, so the LLM sees relevant alternatives ("Srila Prabhupada" →
// candidates including "A. C. Bhaktivedanta Swami Prabhupada") and
// stops minting duplicates for transliteration variants.
//
// Implementations build the trigram index lazily/on-demand from the
// catalog dict tables. The catalog is the only persistent home of
// dict ids — the index is a derived view, throwaway memory state.
type DictFuzzyIndex interface {
	// Match returns up to maxHints candidates whose normalized
	// full_name has trigram-overlap >= threshold with query in the
	// given language. Score-descending order. Empty result is fine —
	// caller falls back to ListDict for a generic top-N.
	//
	// For source kind the index is built on full_name (e.g. "Bhagavad-
	// gita") even though filenames carry short_name ("BG"). Filename-
	// resolution should hit the exact-match path first via
	// LookupIDByName(KindSource, short_name); fuzzy is only a fallback
	// for unusual inputs.
	Match(ctx context.Context, kind catalog.Kind, query, language string,
		threshold float64, maxHints int) ([]DictCandidate, error)

	// Rebuild forces a fresh scan of the catalog. Implementations may
	// rebuild lazily after dict mutations (CreateDict / UpdateDictLocale /
	// DeleteDict); calling Rebuild after a manual SQL edit ensures the
	// in-memory index reflects the new state.
	Rebuild(ctx context.Context) error
}

// DictCandidate is one fuzzy-match result. ID is included for callers
// that want to short-circuit when score is high; Name is the canonical
// full_name in the queried language.
type DictCandidate struct {
	ID    string
	Name  string
	Score float64
}
