// Package review adapts the shared pipeline/review algorithm to the
// orchestrator's ports.Reviewer. It has two responsibilities:
//
//   - Review(draft): deterministic metadata normalization (trim raw fields into
//     the resolved slots, carry the language hint forward). LLM-assisted
//     dictionary resolution against the corpus is future work; this fallback
//     keeps the pipeline shippable without an LLM reviewer wired in.
//   - NormalizeTranscript(raw): turns ASR output into a pipeline
//     transcript.Reviewed by windowing segments through review.BuildChunks and
//     emitting one sentence block per segment — the deterministic fallback the
//     shared review algorithm defines when no LLM reviewer is configured.
package review

import (
	"context"
	"strings"

	"github.com/jiva-studio/lectorium/ingest/internal/domain/ingest"
	preview "github.com/jiva-studio/lectorium/pipeline/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// chunkSize / chunkOverlap mirror the shared algorithm's defaults for windowing
// raw segments; only the fallback (per-segment) path is exercised here.
const (
	chunkSize    = 50
	chunkOverlap = 8
)

// Reviewer implements ports.Reviewer.
type Reviewer struct{}

// New builds a Reviewer.
func New() *Reviewer { return &Reviewer{} }

// Review normalizes a draft's raw metadata into its resolved slots. It never
// fails: unresolved values are left empty for a later (LLM) pass.
func (Reviewer) Review(_ context.Context, d ingest.TrackDraft) (ingest.TrackDraft, error) {
	if d.Lang == "" {
		d.Lang = strings.TrimSpace(d.LangHint)
	}
	if d.Date == "" {
		d.Date = strings.TrimSpace(d.DateRaw)
	}
	d.TitleRaw = strings.TrimSpace(d.TitleRaw)
	d.AuthorRaw = strings.TrimSpace(d.AuthorRaw)
	d.LocationRaw = strings.TrimSpace(d.LocationRaw)
	return d, nil
}

// NormalizeTranscript adapts the package-level normalizer onto ports.Reviewer so
// the worker can window a raw ASR transcript into the stored reviewed artifact.
func (Reviewer) NormalizeTranscript(raw transcript.Raw) transcript.Reviewed {
	return NormalizeTranscript(raw)
}

// NormalizeTranscript converts ASR raw segments into a reviewed transcript
// using the shared chunking algorithm and the deterministic per-segment
// fallback (each segment becomes a sentence block carrying its ms offsets).
func NormalizeTranscript(raw transcript.Raw) transcript.Reviewed {
	out := transcript.Reviewed{
		TrackId:  raw.TrackId,
		Language: raw.Language,
		Version:  1,
	}
	// BuildChunks yields OVERLAPPING windows, so dedup segments by idx as we
	// flatten them back into a linear block list.
	seen := make(map[int]struct{}, len(raw.Segments))
	for _, chunk := range preview.BuildChunks(raw.Segments, chunkSize, chunkOverlap) {
		for _, seg := range chunk.Segs {
			if _, dup := seen[seg.Idx]; dup {
				continue
			}
			seen[seg.Idx] = struct{}{}
			text := strings.TrimSpace(seg.Text)
			if text == "" {
				continue
			}
			out.Blocks = append(out.Blocks, transcript.SentenceBlock{
				Start: seg.Start,
				End:   seg.End,
				Text:  text,
			})
		}
	}
	return out
}
