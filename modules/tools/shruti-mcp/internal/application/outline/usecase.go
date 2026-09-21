// Package outline generates a per-lecture section outline (coarse chapter
// headings with timecodes) and a short description from the reviewed
// transcript, and writes both onto the committed catalog variant.
//
// The generation itself (render transcript → granular-then-collapse → derive
// end spans → describe) lives in the shared pipeline/outline package; this use
// case owns reading the transcript and the catalog + granular-artifact writes.
package outline

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
	pipelineoutline "github.com/jiva-studio/shruti/pipeline/outline"
	outlineport "github.com/jiva-studio/shruti/pipeline/ports/outline"
)

// CatalogWriter is the slice of the catalog the outline use case writes: a
// targeted UPDATE of one (track, language) variant's outline + description. It
// does not touch title/audio/refs, so it's safe to run post-commit over the
// corpus.
type CatalogWriter interface {
	SetVariantOutline(ctx context.Context, trackID, language, outline, description string) error
}

// GranularStore persists the private, offline-only granular outline artifact
// (the pre-collapse fine heading list, each with a derived [start,end) span)
// for the topic-vocabulary pipeline. It is NOT published to the client catalog.
// Optional: a nil GranularStore disables the write (the published coarse
// outline is unaffected).
type GranularStore interface {
	WriteGranularOutline(ctx context.Context, id track.ID, language string, granularJSON []byte) error
}

type UseCase struct {
	Transcripts transcriptport.Store
	LLM         outlineport.Generator
	Catalog     CatalogWriter
	// Granular (optional) receives the fine pre-collapse headings as a private
	// artifact. nil = skip.
	Granular GranularStore
	// Compress (optional) shortens each block before it is sent. nil = as
	// written.
	Compress pipelineoutline.Compressor
	// Batch + BatchJobs enable the half-price asynchronous path. Both nil =
	// synchronous only.
	Batch     Batcher
	BatchJobs *BatchStore
	// MaxTokens caps one batch reply; 0 leaves it to the provider.
	MaxTokens int
	Clock     clockport.Clock
}

// Entry is one stored outline heading: title + [start,end) span in ms. Mirrors
// the JSON persisted in track_variants.outline.
type Entry = pipelineoutline.Entry

type Result struct {
	TrackID     string  `json:"trackId"`
	Language    string  `json:"language"`
	Outline     []Entry `json:"outline"`
	Description string  `json:"description"`
}

func (uc UseCase) Run(ctx context.Context, id track.ID, language string) (Result, error) {
	rev, err := uc.Transcripts.ReadReviewed(ctx, id, language)
	if err != nil {
		// os.ErrNotExist (no reviewed transcript) bubbles up so the fan-out
		// driver reports a clean per-track failure instead of crashing.
		return Result{}, fmt.Errorf("read reviewed transcript: %w", err)
	}

	gen, err := pipelineoutline.Generate(ctx, uc.LLM, rev.Blocks, language, uc.Compress)
	if err != nil {
		return Result{}, err
	}

	if err := uc.write(ctx, id, language, gen); err != nil {
		return Result{}, err
	}
	return Result{TrackID: string(id), Language: language, Outline: gen.Coarse, Description: gen.Description}, nil
}

// write persists one generation. The granular pass goes down BEFORE the catalog
// write, so a granular-write failure surfaces as a clean re-runnable per-track
// failure rather than leaving a published outline without its topic precursor.
func (uc UseCase) write(ctx context.Context, id track.ID, language string, gen pipelineoutline.Result) error {
	if uc.Granular != nil {
		granularJSON, err := json.Marshal(gen.Granular)
		if err != nil {
			return fmt.Errorf("marshal granular outline: %w", err)
		}
		if err := uc.Granular.WriteGranularOutline(ctx, id, language, granularJSON); err != nil {
			return fmt.Errorf("write granular outline: %w", err)
		}
	}
	outlineJSON, err := json.Marshal(gen.Coarse)
	if err != nil {
		return fmt.Errorf("marshal outline: %w", err)
	}
	if err := uc.Catalog.SetVariantOutline(ctx, string(id), language, string(outlineJSON), gen.Description); err != nil {
		return fmt.Errorf("write outline: %w", err)
	}
	return nil
}
