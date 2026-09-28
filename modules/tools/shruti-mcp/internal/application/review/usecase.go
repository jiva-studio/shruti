// Package review proofreads whisper-output transcripts via an LLM provider.
//
// The contract:
//   - The LLM never sees timestamps. Input/output: [{idx, text}, ...].
//   - Start/End are re-attached from the original raw segments by idx.
//   - Chunks overlap; for overlapping segments the version from the chunk
//     where the segment is farther from the edge wins.
//   - On an idx-set mismatch from the provider the chunk is retried, then the
//     next attempt in the chain runs, and finally the affected idx keep their
//     original text and are recorded in fallback_idx.
//
// Run (below) orders the steps; canonical.go holds the canonical-text branch,
// attempts.go the model chain, chunks.go the parallel chunk calls, merge.go
// the merge into sentence blocks, and session.go what is recorded at the end.
package review

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/align"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	"github.com/jiva-studio/shruti/pipeline/ports/sentencesplit"
	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

type UseCase struct {
	Registry    lakeport.Registry
	Transcripts transcriptport.Store
	Reviewers   reviewport.Registry

	// Splitter, when set, computes sentence boundaries deterministically
	// from the corrected text via razdel (or any other implementation).
	// When nil, the code falls back to the LLM's own sentence verdicts
	// (boundary-voting across overlapping chunks). The splitter path
	// keeps boundaries correct even when the LLM corrupts content.
	Splitter sentencesplit.Splitter

	// DefaultAttemptsFor returns the configured attempt chain for a
	// language. Each Attempt carries a model alias list plus optional
	// per-attempt overrides for the hybrid knobs (threshold, expand,
	// premium_min_chars). Wired at startup from
	// config.Review.DefaultReviewAttempts.
	DefaultAttemptsFor func(language string) []Attempt

	ChunkSize        int     // default 50
	Overlap          int     // default 4
	Retries          int     // default 2
	Concurrency      int     // default 6
	LowConfThreshold float64 // segments below this confidence flag a chunk in low_conf_chunks

	// NoiseFilterThreshold drops the text of raw segments whose Whisper
	// confidence is below this cutoff (0 = disabled). The idx + timestamps
	// stay; only Text is silenced. Whisper hallucinates digits / quotes /
	// single dots on noise; very low confidence (<0.20) catches those
	// cleanly without risking real speech (legitimate speech rarely scores
	// below 0.5). Filtered idx are surfaced in chunk artifacts and
	// review.json so audit_track / audit_review can flag low-quality
	// source recordings.
	NoiseFilterThreshold float64

	// Glossary, when non-nil, drives RAG-style canonical-term injection
	// into per-chunk prompts (the LLM sees a "GLOSSARY HINTS" block and
	// is instructed to prefer those spellings). nil disables the
	// behaviour; the rest of the pipeline is unaffected.
	Glossary          glossaryport.Matcher
	GlossaryThreshold float64 // trigram cutoff for Match (default 0.55)
	GlossaryMaxHints  int     // cap injection size (default 10)

	// Align, when non-nil, enables the canonical-text early branch: if the
	// track ships an authoritative transcript (transcript.pdf, or the
	// transcript.html an importer saved) and opts.Method allows it, we skip
	// the LLM and project the ASR timings onto that text instead.
	Align  *align.UseCase
	OutDir string // for the canonical-text presence check; required when Align is set

	// Batch, when set, enables the half-price job path: SubmitBatch queues
	// chunks, CollectBatch turns the replies into chunk artifacts and lets
	// the live path finish whatever the job did not deliver. BatchJobs holds
	// the job records between the two calls.
	Batch          Batcher
	BatchJobs      BatchStore
	BatchModel     string
	BatchMaxTokens int
	BatchPriceIn   float64 // USD per million input tokens
	BatchPriceOut  float64 // USD per million output tokens

	Clock clockport.Clock
}

// Attempt is one entry in the chunk-level fallback chain. Models is
// required; the *override fields override the registry's hybrid knobs
// for this attempt only (only meaningful when len(Models)==2).
type Attempt struct {
	Models          []string
	Threshold       *float64
	Expand          *int
	PremiumMinChars *int
}

type Options struct {
	// Models: aliases registered in the reviewer registry. 0 = use
	// DefaultModelsFor(language), 1 = single pass, 2 = hybrid (first
	// baseline, second premium on low-confidence islands). 3+ rejected.
	Models      []string
	ChunkSize   int // 0 = use UseCase.ChunkSize
	Overlap     int // 0 = use UseCase.Overlap
	Concurrency int // 0 = use UseCase.Concurrency

	// ForceFullRerun: when true, re-run every chunk through the LLM even
	// if a successful artifact already exists. Default (false) reuses
	// chunk_NNNN.json files with ok=true, so transcript_review can be
	// re-invoked after a partial MCP timeout without paying for finished
	// chunks twice.
	ForceFullRerun bool

	// OnlyChunks: when non-empty, restricts the run to the listed chunk
	// indices (0-based, after buildChunks). Other chunks fall through as
	// "fallback" if they don't have a successful artifact yet — useful
	// for targeted reruns of stuck or failed chunks.
	OnlyChunks []int

	// Method selects how the reviewed transcript is produced:
	//   "" or "auto" — prefer PDF align when transcript.pdf is present;
	//                  otherwise fall through to the LLM path.
	//   "pdf"        — force PDF align; error if no PDF.
	//   "llm"        — force LLM path; ignore any PDF.
	// Only meaningful when UseCase.Align is wired.
	Method string
}

type Result struct {
	TrackID      track.ID `json:"track_id"`
	Language     string   `json:"language"`
	Models       []string `json:"models"`
	ChunksRun    int      `json:"chunks_run"`
	Succeeded    int      `json:"succeeded"`
	Fallback     int      `json:"fallback"`
	FallbackIdx  []int    `json:"fallback_idx,omitempty"`
	Blocks       int      `json:"blocks"`
	TotalCostUSD float64  `json:"total_cost_usd,omitempty"`
}

func (uc UseCase) Run(ctx context.Context, id track.ID, language string, opts Options) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageReviewed, Variant: language}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("review: another worker holds stage for %s/%s", id, language)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	if res, handled, err := uc.runCanonical(ctx, id, language, opts.Method); handled || err != nil {
		if err != nil {
			return Result{}, err
		}
		return res, uc.markDone(ctx, id, stageKey, res)
	}

	reviewers, models, err := uc.composeAttempts(language, opts)
	if err != nil {
		return Result{}, err
	}
	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err != nil {
		return Result{}, fmt.Errorf("read raw transcript: %w", err)
	}
	segs, noiseFilteredIdx := uc.filterNoise(raw.Segments)

	chunkSize, overlap := uc.chunkParams(opts)
	concurrency := opts.Concurrency
	if concurrency == 0 {
		concurrency = uc.Concurrency
	}
	if concurrency <= 0 {
		concurrency = 6
	}
	chunks := pipelinereview.BuildChunks(segs, chunkSize, overlap)
	results, err := uc.reviewChunks(ctx, chunkRun{
		id:          id,
		language:    language,
		chunks:      chunks,
		overlap:     overlap,
		concurrency: concurrency,
		reviewers:   reviewers,
		opts:        opts,
	})
	if err != nil {
		return Result{}, err
	}

	merged := uc.merge(ctx, segs, results)
	blocks := buildBlocks(segs, merged)
	if err := uc.Transcripts.WriteReviewed(ctx, transcript.Reviewed{
		TrackID:  string(id),
		Language: language,
		Version:  1,
		Blocks:   blocks,
	}); err != nil {
		return Result{}, err
	}

	agg := aggregateModels(ctx, uc.Transcripts, id, language, len(chunks), uc.LowConfThreshold)
	res = Result{
		TrackID:      id,
		Language:     language,
		Models:       models,
		ChunksRun:    len(chunks),
		Succeeded:    merged.succeeded,
		Fallback:     len(merged.fallbackIdx),
		FallbackIdx:  merged.fallbackIdx,
		Blocks:       len(blocks),
		TotalCostUSD: agg.TotalCostUSD,
	}
	if err := uc.writeSession(ctx, res, session{
		chunkSize:        chunkSize,
		overlap:          overlap,
		concurrency:      concurrency,
		rawSegments:      len(segs),
		noiseFilteredIdx: noiseFilteredIdx,
		agg:              agg,
	}); err != nil {
		return Result{}, err
	}
	return res, uc.markDone(ctx, id, stageKey, res)
}
