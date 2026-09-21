// Package titleport defines the Extractor interface used by tracks_titles_refresh
// to derive a clean human-readable title for a track from its structured
// metadata + a transcript excerpt + an optional PDF header hint.
//
// The canonical implementation lives in internal/infra/title/openaicompat
// and calls a small Haiku-class LLM. Tests can stub this with an in-process
// fake.
package titleport

import "context"

// Input is the bag of fields the extractor templates into the user prompt.
// Empty strings render as "none" in the prompt.
type Input struct {
	Language   string // ISO-639 code of the target title (ru / en / hi)
	Kind       string // morning_walk / conversation / lecture / ...
	References string // comma-joined human-readable refs ("Bhagavad-gītā 8.12, 8.13")
	Location   string // raw location string
	Date       string // YYYY-MM-DD or empty
	HeaderHint string // first bold@16 line from PDF page 1, or "" when absent
	Transcript string // post-skip excerpt, ~500 words
}

// Extractor returns a single short title (3–7 words, no colons, no quotes)
// in Input.Language. Implementations MUST be safe for concurrent use; the
// canonical openaicompat client is goroutine-safe out of the box.
type Extractor interface {
	Name() string
	Extract(ctx context.Context, in Input) (string, error)
}
