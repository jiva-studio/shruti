// Package glossary loads a curated Vaishnava-terminology dictionary and matches
// it against ASR-mangled chunk text via char-trigram overlap. The review
// pipeline injects only the relevant canonical forms into the LLM prompt
// (RAG-style) instead of every term. Shared by the corpus tool and the
// personal-library ingest worker; the curated data is embedded so consumers
// need no external file. Stdlib-only.
package glossary

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

// glossary.json is generated from the human-editable glossary.yaml in this
// directory (yaml → json), and embedded so consumers need no external file.
//
//go:embed glossary.json
var embedded []byte

// Entry is one dictionary row.
type Entry struct {
	// Canonical maps ISO-639 lang code → canonical form for that language.
	Canonical map[string]string `json:"canonical"`
	Category  string            `json:"category"`
	Hint      string            `json:"hint,omitempty"`
	// Aliases maps lang → extra spellings that ALSO route to this entry; the
	// hint shown to the LLM is always the Canonical form.
	Aliases map[string][]string `json:"aliases,omitempty"`
}

// Embedded builds the matcher from the compiled-in curated dictionary.
func Embedded() (*Glossary, error) {
	var entries []Entry
	if err := json.Unmarshal(embedded, &entries); err != nil {
		return nil, fmt.Errorf("glossary: parse embedded: %w", err)
	}
	return Build(entries), nil
}

// Build assembles a Glossary from in-memory entries. Each canonical form and
// each alias gets its own row in the language index — all rows for one Entry
// share an entryID, so the matcher deduplicates and returns the Canonical form
// regardless of which row scored.
func Build(entries []Entry) *Glossary {
	g := &Glossary{Entries: entries, perLang: map[string]*langIndex{}}
	addRow := func(lang, form string, entryID int) {
		idx := g.perLang[lang]
		if idx == nil {
			idx = &langIndex{trigramToEntries: map[string][]int{}}
			g.perLang[lang] = idx
		}
		normalized := normalize(form)
		tris := trigrams(normalized)
		idx.entryNormalized = append(idx.entryNormalized, normalized)
		idx.entryTrigramCount = append(idx.entryTrigramCount, len(tris))
		idx.entryID = append(idx.entryID, entryID)
		localIdx := len(idx.entryID) - 1
		for _, t := range tris {
			idx.trigramToEntries[t] = append(idx.trigramToEntries[t], localIdx)
		}
	}
	for i, e := range entries {
		for lang, form := range e.Canonical {
			addRow(lang, form, i)
		}
		for lang, aliases := range e.Aliases {
			for _, alias := range aliases {
				addRow(lang, alias, i)
			}
		}
	}
	return g
}
