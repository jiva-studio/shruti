// Package outlineport defines the LLM-backed lecture-outline generator surface
// consumed by the outline use case.
package outlineport

import "context"

// Item is one coarse chapter heading the LLM proposes, anchored to a start
// timecode (ms). The use case derives the end span and clamps it against the
// lecture duration; the generator only proposes title + start.
type Item struct {
	Title   string
	StartMs int64
}

// OutlineResult carries both passes of one generation in a single LLM round:
// the granular fine-grained heading list (the raw first pass) and the coarse
// chapters it was collapsed to. Coarse is published to the catalog
// (track_variants.outline); Granular is kept as a private, offline-only
// artifact feeding the topic-vocabulary pipeline and is never shipped to the
// client. Both are in chronological order (title + start ms).
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
