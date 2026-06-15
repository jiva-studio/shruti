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

// Generator turns a time-coded lecture transcript into a short outline and a
// description. Implementations are OpenAI-compatible (Gemini via OpenRouter).
type Generator interface {
	// Outline returns coarse chapter headings (title + start ms) for the whole
	// lecture, in chronological order.
	Outline(ctx context.Context, lectureText, lang string) ([]Item, error)
	// Description returns a short plain-text overview of the lecture in the
	// given language.
	Description(ctx context.Context, lectureText, lang string) (string, error)
}
