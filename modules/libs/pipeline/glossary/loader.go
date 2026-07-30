// Package glossary loads a curated Vaishnava-terminology dictionary and matches
// it against ASR-mangled chunk text via char-trigram overlap. The review
// pipeline injects only the relevant canonical forms into the LLM prompt
// (RAG-style) instead of every term. Shared by the corpus tool and the
// personal-library ingest worker; the curated data is embedded so consumers
// need no external file.
package glossary

import (
	_ "embed"
	"fmt"

	"gopkg.in/yaml.v3"
)

//go:embed glossary.yaml
var embedded []byte

// Entry is one dictionary row.
type Entry struct {
	// Canonical maps ISO-639 lang code → canonical form for that language.
	Canonical map[string]string `yaml:"canonical"`
	Category  string            `yaml:"category"`
	Hint      string            `yaml:"hint,omitempty"`
	// Aliases maps lang → extra spellings that ALSO route to this entry; the
	// hint shown to the LLM is always the Canonical form.
	Aliases map[string][]string `yaml:"aliases,omitempty"`
}

// Embedded builds the matcher from the compiled-in curated dictionary.
func Embedded() (*Glossary, error) {
	return Parse(embedded)
}

// Parse builds a matcher from glossary YAML bytes (used for an operator's
// override file).
func Parse(body []byte) (*Glossary, error) {
	var entries []Entry
	if err := yaml.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("glossary: parse: %w", err)
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
