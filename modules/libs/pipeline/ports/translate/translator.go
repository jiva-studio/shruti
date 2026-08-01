// Package translate defines the LLM-backed text-translation surface shared by
// both ingest paths — the shruti-mcp corpus pipeline and the personal-library
// ingest worker. It translates short spans (a lecture title today; a transcript
// later) from one language to another. Adapters live in the adapter ring (e.g.
// translate/openaicompat over an LLM).
package translate

import "context"

// Translator turns text into its translation in another language.
// Implementations are OpenAI-compatible.
type Translator interface {
	// Translate returns text rendered in toLang. fromLang is the source
	// language (ISO code, may be "" when unknown); the result is the
	// translation only, no commentary.
	Translate(ctx context.Context, text, fromLang, toLang string) (string, error)
	// TranslateBatch renders each input into toLang and returns the results in
	// the SAME order and length as the input — one translation per element, so
	// callers can zip them back onto transcript blocks by index. It is the
	// primitive for translating a whole transcript without one LLM call per line.
	TranslateBatch(ctx context.Context, texts []string, fromLang, toLang string) ([]string, error)
}
