// Package glossary defines the Matcher port the review use case calls to
// inject canonical-term hints into per-chunk LLM prompts. The concrete
// trigram matcher lives in internal/infra/glossary; review depends on
// this interface so application/ stays free of infra imports.
package glossary

// Matcher renders a "GLOSSARY HINTS" prompt block for one chunk of text
// in one language. Empty result when there are no hits or when the
// matcher has no entries for the requested language.
//
// threshold and maxHints come from review config — the matcher trusts
// them and applies its own clamp/defaults internally.
type Matcher interface {
	RenderHints(text, language string, threshold float64, maxHints int) string
}
