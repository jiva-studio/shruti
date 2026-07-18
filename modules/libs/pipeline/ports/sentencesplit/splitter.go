// Package sentencesplit splits a passage of text into sentences. Used
// by the review pipeline to assemble idx → sentence groupings without
// relying on the LLM (which sometimes corrupts segment boundaries).
package sentencesplit

import "context"

// Sentence describes one detected sentence by character offset into the
// input text.
type Sentence struct {
	Start int    `json:"start"`
	Stop  int    `json:"stop"`
	Text  string `json:"text"`
}

// Splitter takes a string and returns the detected sentences in order.
// Implementations MUST be safe for concurrent calls; the canonical
// razdel adapter serializes through a mutex internally.
type Splitter interface {
	Split(ctx context.Context, text string) ([]Sentence, error)
	// Close releases any underlying resources (e.g. terminates a child
	// process). After Close, Split must return an error.
	Close() error
}
