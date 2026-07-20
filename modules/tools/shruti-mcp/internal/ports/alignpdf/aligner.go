// Package alignpdfport defines the Aligner interface used by the alignpdf
// use case to convert a canonical PDF transcript + raw ASR JSON into a
// reviewed v2 transcript.
//
// The canonical implementation lives in internal/infra/alignpdf/python and
// wraps a long-lived Python subprocess (mirrors the razdel pattern). Tests
// can stub this with an in-process fake.
package alignpdfport

import (
	"context"

	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// Request describes one alignment job. Both paths are absolute.
type Request struct {
	PDFPath  string
	RawPath  string
	Language string
}

// Aligner runs the alignment over the (PDF, raw ASR) pair and returns a
// fully-formed Reviewed transcript with v2 schema (sentence, verse:text,
// verse:translation, paragraph blocks; references resolved to canonical
// catalog source IDs where possible).
//
// Implementations MUST be safe for concurrent calls; the canonical Python
// adapter serializes through a mutex internally.
type Aligner interface {
	Align(ctx context.Context, req Request) (transcript.Reviewed, error)
	// ExtractTitleHint returns the first bold@16 line on page 1 of the
	// PDF, IAST-converted; "" when the PDF has no such header line.
	// Used by tracks_titles_refresh as a soft hint to the title LLM —
	// the LLM, not this layer, decides whether the hint is useful.
	ExtractTitleHint(ctx context.Context, pdfPath string) (string, error)
	// Close releases any underlying resources (e.g. terminates a child
	// process). After Close, Align must return an error.
	Close() error
}
