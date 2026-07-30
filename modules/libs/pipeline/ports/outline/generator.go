// Package outline defines the LLM-backed lecture-outline generator surface:
// a granular-then-collapse chapter pass plus a short description. It is the
// shared port both ingest paths speak — the lectorium-mcp corpus pipeline and
// the personal-library ingest worker. Adapters live in the adapter ring (e.g.
// outline/openaicompat over an LLM).
package outline

import "context"

// Item is one chapter heading the LLM proposes, anchored to a start timecode
// (ms). The caller derives the end span and clamps it against the lecture
// duration; the generator only proposes title + start.
type Item struct {
	Title   string
	StartMs int64
}

// OutlineResult carries both passes of one generation in a single LLM round:
// the granular fine-grained heading list (the raw first pass) and the coarse
// chapters it was collapsed to. Coarse is what a catalog publishes; Granular
// feeds the offline topic-vocabulary pipeline. Both are chronological.
type OutlineResult struct {
	Granular []Item
	Coarse   []Item
}

// Generator turns a time-coded lecture transcript into a short outline and a
// description. Implementations are OpenAI-compatible (Gemini via OpenRouter).
type Generator interface {
	// Outline returns both the granular and the collapsed coarse chapter
	// headings for the whole lecture, produced in one LLM round.
	Outline(ctx context.Context, lectureText, lang string) (OutlineResult, error)
	// Description returns a short plain-text overview of the lecture in the
	// given language.
	Description(ctx context.Context, lectureText, lang string) (string, error)
}
