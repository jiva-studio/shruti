// Package glossary loads a curated Vaishnava-terminology dictionary and
// matches it against whisper-mangled chunk text via char-trigram overlap.
// Used by the review pipeline to inject only the relevant canonical
// forms into the LLM prompt (RAG-style) instead of every term.
package glossary

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Entry is one row from the YAML dictionary.
type Entry struct {
	// Canonical maps ISO-639 lang code → canonical form for that
	// language. Languages with no canonical form here are simply not
	// matched against chunks of that language.
	Canonical map[string]string `yaml:"canonical"`
	Category  string            `yaml:"category"`
	Hint      string            `yaml:"hint,omitempty"`
	// Aliases maps lang → extra spellings that should ALSO route to this
	// entry. The hint shown to the LLM is always the Canonical form;
	// aliases only widen the trigram index. Use sparingly — only when
	// trigram overlap legitimately fails (short toponyms whisper hears
	// in multiple ways: «Маяпур» / «Майяпур» / «Майпур»).
	Aliases map[string][]string `yaml:"aliases,omitempty"`
}

// Load parses the glossary YAML at path. Returns a fully-built Glossary
// ready to Match against chunk text.
func Load(path string) (*Glossary, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("glossary: read %s: %w", path, err)
	}
	var entries []Entry
	if err := yaml.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("glossary: parse %s: %w", path, err)
	}
	return Build(entries), nil
}

// Build assembles a Glossary from in-memory entries (used by tests too).
// Each canonical form and each alias gets its own row in the language
// index — but all rows for one Entry share the same entryID, so the
// matcher deduplicates and returns the Canonical form regardless of
// which row scored.
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
