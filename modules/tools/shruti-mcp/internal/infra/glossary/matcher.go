package glossary

import (
	"sort"
	"strings"
)

// langIndex is the trigram inverted index for a single language.
// entryNormalized[i], entryTrigramCount[i], entryID[i] all index by
// the language-local position; trigramToEntries maps a trigram → those
// language-local positions.
type langIndex struct {
	entryNormalized   []string
	entryTrigramCount []int
	entryID           []int            // position in Glossary.Entries
	trigramToEntries  map[string][]int // trigram → langIndex-local positions
}

// Glossary is the in-memory dictionary plus per-language trigram index.
// Safe for concurrent reads after Build/Load returns.
type Glossary struct {
	Entries []Entry
	perLang map[string]*langIndex
}

// Hint is one matched canonical term plus context for the LLM.
type Hint struct {
	Canonical string
	Category  string
	Hint      string
	Score     float64
}

// Match returns up to maxHints canonical terms whose normalized forms
// have trigram-overlap >= threshold against the chunk text. lang
// selects which canonical (Russian / English / etc.) to match. Empty
// result when text or the language index is empty.
//
// Algorithm:
//  1. Normalize whole text once.
//  2. Pull every trigram present in the text into a set.
//  3. For each entry of this language: count overlapping trigrams,
//     compute score = matched / entry's trigram count.
//  4. Keep entries with score >= threshold, sort by score desc, cut to maxHints.
func (g *Glossary) Match(text, lang string, threshold float64, maxHints int) []Hint {
	if g == nil || text == "" || lang == "" {
		return nil
	}
	idx, ok := g.perLang[lang]
	if !ok || len(idx.entryID) == 0 {
		return nil
	}
	if threshold <= 0 {
		threshold = 0.50
	}
	if maxHints <= 0 {
		maxHints = 10
	}

	textNorm := normalize(text)
	if textNorm == "" {
		return nil
	}
	textTrigrams := trigrams(textNorm)
	textSet := make(map[string]struct{}, len(textTrigrams))
	for _, t := range textTrigrams {
		textSet[t] = struct{}{}
	}

	// Tally trigram hits per language-local entry.
	hits := make([]int, len(idx.entryID))
	for tri := range textSet {
		for _, localIdx := range idx.trigramToEntries[tri] {
			hits[localIdx]++
		}
	}

	type scored struct {
		localIdx int
		score    float64
	}
	scoredHits := make([]scored, 0, len(hits))
	for i, h := range hits {
		if h == 0 {
			continue
		}
		denom := idx.entryTrigramCount[i]
		if denom == 0 {
			continue
		}
		score := float64(h) / float64(denom)
		if score < threshold {
			continue
		}
		// Very short canonicals (≤4 chars normalized) can't be reliably
		// fuzzy-matched — text trigrams have no word boundaries after
		// normalization, so the trigram score loses meaning. Require an
		// exact substring match instead. Anything shorter than 3 chars
		// (e.g. "ом") would still cause too many false positives even
		// as a substring; skip those entirely from the matcher and let
		// the LLM handle them.
		nLen := len([]rune(idx.entryNormalized[i]))
		if nLen < 3 {
			continue
		}
		if nLen <= 4 {
			if !strings.Contains(textNorm, idx.entryNormalized[i]) {
				continue
			}
		}
		scoredHits = append(scoredHits, scored{localIdx: i, score: score})
	}

	sort.Slice(scoredHits, func(i, j int) bool {
		return scoredHits[i].score > scoredHits[j].score
	})
	if len(scoredHits) > maxHints {
		scoredHits = scoredHits[:maxHints]
	}

	out := make([]Hint, 0, len(scoredHits))
	seen := map[string]struct{}{}
	for _, s := range scoredHits {
		entry := g.Entries[idx.entryID[s.localIdx]]
		canonical := entry.Canonical[lang]
		if _, dup := seen[canonical]; dup {
			continue
		}
		seen[canonical] = struct{}{}
		out = append(out, Hint{
			Canonical: canonical,
			Category:  entry.Category,
			Hint:      entry.Hint,
			Score:     s.score,
		})
	}
	return out
}

// RenderHints implements the ports/glossary.Matcher contract: matches in
// one shot and renders the hint block for the LLM prompt. Empty result
// when no hints meet the threshold.
func (g *Glossary) RenderHints(text, language string, threshold float64, maxHints int) string {
	return RenderExtraPrompt(g.Match(text, language, threshold, maxHints))
}

// RenderExtraPrompt formats the hints as a "GLOSSARY HINTS" block ready
// to inject into the user prompt. Returns empty string if there are no
// hints — caller can include the block or not without checking length.
func RenderExtraPrompt(hints []Hint) string {
	if len(hints) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("GLOSSARY HINTS (canonical Vaishnava terms that may appear in this chunk; prefer these exact spellings over what whisper produced):\n")
	for _, h := range hints {
		b.WriteString("- ")
		b.WriteString(h.Canonical)
		if h.Category != "" {
			b.WriteString(" (")
			b.WriteString(h.Category)
			b.WriteString(")")
		}
		if h.Hint != "" {
			b.WriteString(" — ")
			b.WriteString(h.Hint)
		}
		b.WriteString("\n")
	}
	return b.String()
}
