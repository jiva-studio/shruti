// Package library reads the library SQLite (library.db): structured verses
// (original script + stored IAST transliteration + per-language translations),
// documents (commentary / prose_chapter / letter), and derived per-source
// stats (token scheme, verse count, has-commentary).
//
// Data rules of the published file:
//   - ".0" tokens are chapter summaries, not verses — skipped by ListVerses.
//   - A merged verse (e.g. BG 1.16-18) is stored as one row per member token,
//     each holding the identical block; ListVerses collapses the run into a
//     single item carrying a `covers` span.
package library

import (
	"context"
	"sort"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/sqlitedb"
)

// Repo is the library reader over a swappable read-only handle. Every call
// leases the current database for its own duration.
type Repo struct{ h *sqlitedb.Handle }

func New(h *sqlitedb.Handle) *Repo { return &Repo{h: h} }

// read runs fn against a lease of the current database.
func (r *Repo) read(fn func(q catalogdb.Querier) error) error {
	db, release, err := r.h.Acquire()
	if err != nil {
		return err
	}
	defer release()
	return fn(db)
}

// ── Verses ─────────────────────────────────────────────────────────────────

// Verse is a verse row: original script and stored IAST, both verbatim.
type Verse = catalogdb.Verse

// Translation is one translation record of a verse in one language.
type Translation = catalogdb.Translation

// Word is one pada gloss within a verse's word-by-word breakdown.
type Word = catalogdb.Word

// GetByID returns a verse by its verse_id, or (nil,nil) if absent.
func (r *Repo) GetByID(ctx context.Context, id string) (*Verse, error) {
	return r.verse(func(q catalogdb.Querier) (catalogdb.Verse, bool, error) {
		return catalogdb.VerseByID(ctx, q, id)
	})
}

// GetByRef returns a verse by (source_id, tokens), or (nil,nil) if absent.
func (r *Repo) GetByRef(ctx context.Context, sourceID, tokens string) (*Verse, error) {
	return r.verse(func(q catalogdb.Querier) (catalogdb.Verse, bool, error) {
		return catalogdb.VerseAt(ctx, q, sourceID, tokens)
	})
}

func (r *Repo) verse(get func(q catalogdb.Querier) (catalogdb.Verse, bool, error)) (*Verse, error) {
	var (
		v  catalogdb.Verse
		ok bool
	)
	if err := r.read(func(q catalogdb.Querier) (err error) {
		v, ok, err = get(q)
		return err
	}); err != nil || !ok {
		return nil, err
	}
	return &v, nil
}

// Translations returns every translation of a verse in `lang`, canonical
// first.
func (r *Repo) Translations(ctx context.Context, verseID, lang string) ([]Translation, error) {
	var out []Translation
	err := r.read(func(q catalogdb.Querier) (err error) {
		out, err = catalogdb.TranslationsOf(ctx, q, verseID, lang)
		return err
	})
	return out, err
}

// GetTranslation returns one translation (verse, lang, kind), or (nil,nil) if absent.
func (r *Repo) GetTranslation(ctx context.Context, verseID, lang, kind string) (*Translation, error) {
	var (
		t  Translation
		ok bool
	)
	if err := r.read(func(q catalogdb.Querier) (err error) {
		t, ok, err = catalogdb.TranslationOf(ctx, q, verseID, lang, kind)
		return err
	}); err != nil || !ok {
		return nil, err
	}
	return &t, nil
}

// Transliteration returns the verse transliteration in `lang`'s script
// (materialised at import for ru/uk/sr-Cyrl and the Latin IAST for
// en/sr-Latn), or iastFallback — the raw IAST of library_verses — for a
// language with none stored.
func (r *Repo) Transliteration(ctx context.Context, verseID, lang, iastFallback string) (string, error) {
	if lang == "" {
		return iastFallback, nil
	}
	var (
		text string
		ok   bool
	)
	if err := r.read(func(q catalogdb.Querier) (err error) {
		text, ok, err = catalogdb.TransliterationOf(ctx, q, verseID, lang)
		return err
	}); err != nil {
		return "", err
	}
	if !ok {
		return iastFallback, nil
	}
	return text, nil
}

// Words returns the word-by-word breakdown for (verse, lang, kind), ordered.
func (r *Repo) Words(ctx context.Context, verseID, lang, kind string) ([]Word, error) {
	var out []Word
	err := r.read(func(q catalogdb.Querier) (err error) {
		out, err = catalogdb.WordsOf(ctx, q, verseID, lang, kind)
		return err
	})
	return out, err
}

// VerseCovers returns the merged-verse span a verse belongs to, e.g.
// "1.16-1.18", or "" for a normal (non-merged) verse. A merged verse is stored
// as one row per member token, each holding the identical text, so the span is
// every row of the source with the same non-empty text. Empty-text rows
// (chapter summaries) never merge.
func (r *Repo) VerseCovers(ctx context.Context, v *Verse) (string, error) {
	if v == nil || v.Text == "" {
		return "", nil
	}
	var members []catalogdb.Verse
	if err := r.read(func(q catalogdb.Querier) (err error) {
		members, err = catalogdb.VersesWithText(ctx, q, v.SourceID, v.Text)
		return err
	}); err != nil {
		return "", err
	}
	if len(members) < 2 {
		return "", nil
	}
	toks := make([]string, len(members))
	for i, m := range members {
		toks[i] = m.Tokens
	}
	sort.Slice(toks, func(i, j int) bool { return refs.CompareTokens(toks[i], toks[j]) < 0 })
	return toks[0] + "-" + toks[len(toks)-1], nil
}

// VerseListItem is one entry from ListVerses (merged rows collapsed).
type VerseListItem struct {
	ID           string
	SourceID     string
	Tokens       string            // first member token
	Covers       string            // "1.16-1.18" for a merged run, else ""
	Translations map[string]string // lang -> canonical translation (for preview)
}

// ListVerses returns the verses of a source (optionally restricted to a
// chapter/canto prefix), numerically ordered, with ".0" summaries skipped and
// merged runs collapsed.
func (r *Repo) ListVerses(ctx context.Context, sourceID, prefix string) ([]VerseListItem, error) {
	var items []VerseListItem
	err := r.read(func(q catalogdb.Querier) error {
		all, err := catalogdb.VersesOf(ctx, q, sourceID, prefix)
		if err != nil {
			return err
		}
		sort.Slice(all, func(i, j int) bool { return refs.CompareTokens(all[i].Tokens, all[j].Tokens) < 0 })
		items = collapseVerses(sourceID, all)
		ids := make([]string, len(items))
		for i, it := range items {
			ids[i] = it.ID
		}
		translations, err := catalogdb.CanonicalTranslationsOf(ctx, q, ids)
		if err != nil {
			return err
		}
		for i := range items {
			items[i].Translations = translations[items[i].ID]
			if items[i].Translations == nil {
				items[i].Translations = map[string]string{}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

// collapseVerses drops chapter summaries and folds each run of consecutive
// rows sharing the same non-empty text into one item with a covers span.
func collapseVerses(sourceID string, all []catalogdb.Verse) []VerseListItem {
	var items []VerseListItem
	for i := 0; i < len(all); {
		v := all[i]
		if refs.IsChapterSummary(v.Tokens) {
			i++
			continue
		}
		j := i + 1
		if v.Text != "" {
			for j < len(all) && all[j].Text == v.Text && !refs.IsChapterSummary(all[j].Tokens) {
				j++
			}
		}
		item := VerseListItem{ID: v.ID, SourceID: sourceID, Tokens: v.Tokens}
		if j-i > 1 {
			item.Covers = v.Tokens + "-" + all[j-1].Tokens
		}
		items = append(items, item)
		i = j
	}
	return items
}
