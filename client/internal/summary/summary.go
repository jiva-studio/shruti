// Package summary turns a finished meeting transcript into a written summary.
// The default implementation calls the Anthropic (Claude) Messages API.
package summary

import "context"

// Summarizer produces a summary of a meeting transcript.
type Summarizer interface {
	// Summarize returns a written summary of the transcript, or an error.
	Summarize(ctx context.Context, transcript string) (string, error)
}
