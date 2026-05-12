// Package runpipeline chains the per-track stages: ingest → normalize →
// metadata → transcribe → review → commit. It's resumable (each stage is
// idempotent and skips when already Done) and per-track-isolated (a failure
// on one track doesn't stop others).
package runpipeline

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/sync/errgroup"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/commit"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/extractmeta"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/ingest"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/normalize"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/review"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/transcribe"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	lakeport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/lake"
)

type UseCase struct {
	Registry   lakeport.Registry
	Ingest     ingest.UseCase
	Normalize  normalize.UseCase
	Metadata   extractmeta.UseCase
	Transcribe transcribe.UseCase
	Review     review.UseCase
	Commit     commit.UseCase

	DefaultLanguage string
}

type Options struct {
	Language string         // default = uc.DefaultLanguage
	Force    bool           // reset all stages before running
	UpTo     pipeline.Stage // stop after this stage (default: StageCommitted)

	// From restricts the run to stages at or after this point. Stages
	// strictly before From are assumed Done and skipped via the
	// alreadyDone() check. The From stage and its dependents are reset
	// to Pending before the run (rolling back commits if needed) so
	// stale artifacts don't survive. Mutually exclusive with Only.
	From pipeline.Stage

	// Only runs exactly one stage and resets its dependents to Pending.
	// Equivalent to From=Only and UpTo=Only — supplied as a single
	// parameter for ergonomics. Mutually exclusive with From / UpTo.
	// The MCP layer rejects Only=ingested (re-ingesting re-hashes the
	// file → mints a new track_id → orphans every catalog row).
	Only pipeline.Stage

	// ReviewModels, if non-empty, overrides the configured default models
	// for the review stage on this batch. Length 1 = single-pass, 2 =
	// hybrid baseline+premium. Empty = use the per-language defaults
	// from config.
	ReviewModels []string
}

type FileSummary struct {
	Path     string `json:"path"`
	TrackId  string `json:"track_id,omitempty"`
	Status   string `json:"status"` // committed | incomplete | failed | skipped
	Reached  string `json:"reached_stage,omitempty"`
	Error    string `json:"error,omitempty"`
}

type Result struct {
	Total     int           `json:"total"`
	Committed int           `json:"committed"`
	Failed    int           `json:"failed"`
	Files     []FileSummary `json:"files"`
}

// Run processes one path. Returns a single FileSummary. Use RunPaths for many.
func (uc UseCase) Run(ctx context.Context, path string, opts Options) FileSummary {
	// Only collapses both UpTo and From: re-run exactly that stage, with
	// dependents reset to Pending. Forms a single point in the pipeline.
	if opts.Only != "" {
		opts.UpTo = opts.Only
		opts.From = opts.Only
	}
	upTo := opts.UpTo
	if upTo == "" {
		upTo = pipeline.StageCommitted
	}

	summary := FileSummary{Path: path}

	// 1. Ingest.
	ingestRes, err := uc.Ingest.Run(ctx, path)
	if err != nil {
		// Extras (bhajan/kirtan/walks/fragments) are intentionally not
		// part of the catalog — surface as "skipped", not "failed".
		if errors.Is(err, ingest.ErrSkipExtra) {
			summary.Status = "skipped"
			summary.Reached = "ingest"
			return summary
		}
		summary.Status = "failed"
		summary.Error = "ingest: " + err.Error()
		return summary
	}
	summary.TrackId = string(ingestRes.TrackId)

	// Per-track language resolution. Caller override (opts.Language) wins
	// for ad-hoc reruns; otherwise we read what ingest stored on the file
	// row (extracted from outbox/sorted/<lang>/...). Fall back to the
	// server default only when neither source has a value.
	lang := opts.Language
	if lang == "" {
		if v, err := uc.Registry.LookupLanguage(ctx, ingestRes.TrackId); err == nil && v != "" {
			lang = v
		}
	}
	if lang == "" {
		lang = uc.DefaultLanguage
	}

	if opts.Force {
		// Rollback any committed catalog rows BEFORE the cascade flips
		// commit→pending. Otherwise the registry says "pending" while
		// current.db still holds the old track/variant rows and the next
		// commit either UPSERT-overwrites them silently or hits a
		// constraint (orphaned references).
		_ = uc.Commit.RollbackIfCommitted(ctx, ingestRes.TrackId)
		_ = uc.Registry.ResetStagesFor(ctx, ingestRes.TrackId)
	} else if opts.From != "" && opts.From != pipeline.StageIngested {
		// Per-stage re-run (only=X / from=X up_to=Y). Same invariant as
		// Force: catalog rows must be rolled back BEFORE the stage cascade,
		// otherwise current.db is left referring to stages that just went
		// back to Pending. RollbackIfCommitted is a no-op when there's
		// nothing to roll back, so it's cheap to call unconditionally for
		// any From upstream of committed.
		if uc.upstreamOfCommitted(opts.From) {
			_ = uc.Commit.RollbackIfCommitted(ctx, ingestRes.TrackId)
		}
		fromKey := pipeline.Key{Stage: opts.From}
		if !opts.From.LanguageAgnostic() {
			fromKey.Variant = lang
		}
		_ = uc.Registry.ResetStageAndDependents(ctx, ingestRes.TrackId, fromKey)
	}

	id := ingestRes.TrackId

	if upTo == pipeline.StageIngested {
		summary.Reached = "ingest"
		summary.Status = "committed"
		return summary
	}

	// Stage 1: normalize (gates everything downstream — metadata audio probe
	// and transcribe both read the canonical mp3).
	summary.Reached = "normalize"
	if !uc.alreadyDone(ctx, id, pipeline.Key{Stage: pipeline.StageNormalized}) {
		if err := uc.Normalize.Run(ctx, id); err != nil {
			summary.Status = "failed"
			summary.Error = "normalize: " + err.Error()
			return summary
		}
	}
	if upTo == pipeline.StageNormalized {
		summary.Status = "committed"
		return summary
	}

	// Stages 2 & 3 in parallel: metadata_extract reads filename/parent dirs +
	// audio probe; transcribe reads the canonical mp3. Independent — fire as
	// errgroup. Each picks up its own throttle (transcribe is sem-bounded).
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		if uc.alreadyDone(gctx, id, pipeline.Key{Stage: pipeline.StageMetadataExtracted}) {
			return nil
		}
		_, err := uc.Metadata.Run(gctx, id, path)
		if err != nil {
			return fmt.Errorf("metadata: %w", err)
		}
		return nil
	})
	g.Go(func() error {
		if uc.alreadyDone(gctx, id, pipeline.Key{Stage: pipeline.StageTranscribed, Variant: lang}) {
			return nil
		}
		_, err := uc.Transcribe.Run(gctx, id, lang, transcribe.Options{})
		if err != nil {
			return fmt.Errorf("transcribe: %w", err)
		}
		return nil
	})
	if err := g.Wait(); err != nil {
		// Reached field is "metadata_or_transcribe" since either could be the
		// failing one; the error message itself names which.
		summary.Reached = "metadata_or_transcribe"
		summary.Status = "failed"
		summary.Error = err.Error()
		return summary
	}
	if upTo == pipeline.StageMetadataExtracted || upTo == pipeline.StageTranscribed {
		summary.Reached = string(upTo)
		summary.Status = "committed"
		return summary
	}

	// Stage 4: review — depends on transcribe. Idempotent: skipped when
	// already done. Surgical re-reviews (force_full_rerun / only_chunks)
	// go through the synchronous transcript_review tool, not the batch
	// path — those knobs aren't applicable per-batch.
	summary.Reached = "review"
	reviewKey := pipeline.Key{Stage: pipeline.StageReviewed, Variant: lang}
	if !uc.alreadyDone(ctx, id, reviewKey) {
		if _, err := uc.Review.Run(ctx, id, lang, review.Options{
			Models: opts.ReviewModels,
		}); err != nil {
			summary.Status = "failed"
			summary.Error = "review: " + err.Error()
			return summary
		}
	}
	if upTo == pipeline.StageReviewed {
		summary.Status = "committed"
		return summary
	}

	// Stage 5: commit — depends on metadata + review.
	summary.Reached = "commit"
	if !uc.alreadyDone(ctx, id, pipeline.Key{Stage: pipeline.StageCommitted, Variant: lang}) {
		res, err := uc.Commit.Run(ctx, id, lang)
		if err != nil {
			summary.Status = "failed"
			summary.Error = "commit: " + err.Error()
			return summary
		}
		if !res.OK {
			summary.Status = "incomplete"
			summary.Error = fmt.Sprintf("commit incomplete: missing=%v invalid=%v", res.Missing, res.Invalid)
			return summary
		}
	}

	summary.Status = "committed"
	return summary
}

func (uc UseCase) RunPaths(ctx context.Context, paths []string, opts Options) Result {
	res := Result{Total: len(paths)}
	for _, p := range paths {
		fs := uc.Run(ctx, p, opts)
		switch fs.Status {
		case "committed":
			res.Committed++
		case "failed", "incomplete":
			res.Failed++
		}
		res.Files = append(res.Files, fs)
	}
	return res
}

// RunAll iterates over all files in the registry that aren't yet committed
// for the given language. Useful as `pipeline_run {all: true}`.
//
// When opts.Language is set, restricts the batch to files whose lake path
// lies under .../sorted/<lang>/... Without this filter, `language=en` would
// only override the per-track language while still processing every track
// in the registry — burning LLM budget on Russian tracks.
func (uc UseCase) RunAll(ctx context.Context, opts Options) (Result, error) {
	files, err := uc.Registry.ListPending(ctx, pipeline.StageIngested)
	if err != nil {
		return Result{}, err
	}
	paths := make([]string, 0, len(files))
	needle := ""
	if opts.Language != "" {
		needle = "/sorted/" + opts.Language + "/"
	}
	for _, f := range files {
		if needle != "" && !strings.Contains(f.Source.Path, needle) {
			continue
		}
		paths = append(paths, f.Source.Path)
	}
	return uc.RunPaths(ctx, paths, opts), nil
}

// upstreamOfCommitted reports whether resetting `s` would invalidate a
// committed catalog row. True for every stage in the linear pipeline
// except StageCommitted itself.
func (uc UseCase) upstreamOfCommitted(s pipeline.Stage) bool {
	switch s {
	case pipeline.StageIngested, pipeline.StageNormalized,
		pipeline.StageMetadataExtracted, pipeline.StageTranscribed,
		pipeline.StageReviewed:
		return true
	}
	return false
}

func (uc UseCase) alreadyDone(ctx context.Context, id track.Id, key pipeline.Key) bool {
	row, ok, err := uc.Registry.GetStage(ctx, id, key)
	if err != nil || !ok {
		return false
	}
	return row.Status == pipeline.StatusDone
}

