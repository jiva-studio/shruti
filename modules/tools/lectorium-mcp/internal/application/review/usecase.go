// Package review proofreads whisper-output transcripts via an LLM provider.
//
// Critical contract (see plan §"Ревью с чанками"):
//   - The LLM never sees timestamps. Input/output: [{idx, text}, ...].
//   - We re-attach Start/End from the original Raw by Idx.
//   - Chunks overlap; for overlapping segments we prefer the version from
//     the chunk where the segment is farther from the edge.
//   - On idx-set mismatch from the provider, retry; finally fall back to
//     original text for the affected idx and record fallback_idx in payload.
package review

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/alignpdf"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/stagefail"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	pipelinereview "github.com/jiva-studio/lectorium/pipeline/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
	glossaryport "github.com/jiva-studio/lectorium/pipeline/ports/glossary"
	lakeport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	"github.com/jiva-studio/lectorium/pipeline/ports/sentencesplit"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
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

	// AlignPDF, when non-nil, enables the PDF-canon early-branch: if a
	// transcript.pdf is present alongside the raw ASR for this track and
	// opts.Method allows it, we skip the LLM path entirely and align the
	// canonical PDF text to the raw timestamps. Run() handles claiming
	// the stage once and dispatches to AlignPDF.RunInternal for the
	// alignment work.
	AlignPDF *alignpdf.UseCase
	OutDir   string // for PDF presence check; required when AlignPDF is set
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
	ChunkSize   int    // 0 = use UseCase.ChunkSize
	Overlap     int    // 0 = use UseCase.Overlap
	Concurrency int    // 0 = use UseCase.Concurrency

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
	// Only meaningful when UseCase.AlignPDF is wired.
	Method string
}

type Result struct {
	TrackId     track.Id `json:"track_id"`
	Language    string   `json:"language"`
	Models      []string `json:"models"`
	ChunksRun   int      `json:"chunks_run"`
	Succeeded   int      `json:"succeeded"`
	Fallback    int      `json:"fallback"`
	FallbackIdx []int    `json:"fallback_idx,omitempty"`
	Blocks      int      `json:"blocks"`
	TotalCostUSD float64 `json:"total_cost_usd,omitempty"`
}

func (uc UseCase) Run(ctx context.Context, id track.Id, language string, opts Options) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageReviewed, Variant: language}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("review: another worker holds stage for %s/%s", id, language)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	// PDF-canon early branch. When a track ships with an authoritative
	// transcript.pdf, the canonical text is already perfect; we just need
	// to project ASR timestamps onto it. Skips the LLM entirely.
	if uc.AlignPDF != nil {
		method := strings.ToLower(strings.TrimSpace(opts.Method))
		if method == "" {
			method = "auto"
		}
		// Either canonical source skips the LLM: the text is already correct
		// and only needs the ASR timings projected onto it.
		haveCanonical := alignpdf.PDFExists(uc.OutDir, id) || alignpdf.TextExists(uc.OutDir, id)
		switch method {
		case "pdf":
			if !haveCanonical {
				return Result{}, fmt.Errorf("review: method=pdf requested but no canonical transcript for %s", id)
			}
			ar, err := uc.AlignPDF.RunInternal(ctx, id, language)
			if err != nil {
				return Result{}, err
			}
			res = Result{TrackId: id, Language: language, Blocks: ar.Blocks}
			resBody, _ := json.Marshal(res)
			if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, resBody, ""); err != nil {
				return Result{}, err
			}
			return res, nil
		case "auto":
			if haveCanonical {
				ar, err := uc.AlignPDF.RunInternal(ctx, id, language)
				if err != nil {
					return Result{}, err
				}
				res = Result{TrackId: id, Language: language, Blocks: ar.Blocks}
				resBody, _ := json.Marshal(res)
				if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, resBody, ""); err != nil {
					return Result{}, err
				}
				return res, nil
			}
			// fall through to LLM
		case "llm":
			// fall through to LLM
		default:
			return Result{}, fmt.Errorf("review: unknown method %q (want auto|pdf|llm)", method)
		}
	}

	// Resolve the attempt chain. Tool params (opts.Models) carry no chain
	// semantics — they're a single ad-hoc attempt without overrides.
	// Config-driven defaults can supply multiple attempts with per-attempt
	// hybrid overrides; per-chunk we fall through them on audit failure.
	var attempts []Attempt
	if len(opts.Models) > 0 {
		attempts = []Attempt{{Models: opts.Models}}
	} else if uc.DefaultAttemptsFor != nil {
		attempts = uc.DefaultAttemptsFor(language)
	}
	if len(attempts) == 0 {
		return Result{}, fmt.Errorf("review: no models specified and no default configured for language %q", language)
	}
	// Resolve every attempt up front so a typo in YAML fails loudly at
	// the start instead of mid-batch when the first chunk falls through
	// to a broken fallback.
	attemptReviewers := make([]reviewport.Reviewer, len(attempts))
	for i, a := range attempts {
		overrides := &reviewport.HybridOverrides{
			Threshold:       a.Threshold,
			Expand:          a.Expand,
			PremiumMinChars: a.PremiumMinChars,
		}
		r, err := uc.Reviewers.Compose(a.Models, overrides)
		if err != nil {
			return Result{}, fmt.Errorf("review: attempt %d (%v): %w", i, a.Models, err)
		}
		attemptReviewers[i] = r
	}
	// models is the alias list of the FIRST attempt — what gets recorded
	// in Result.Models and review.json::models. Per-chunk artifacts still
	// reflect the actual attempt that succeeded.
	models := attempts[0].Models

	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err != nil {
		return Result{}, fmt.Errorf("read raw transcript: %w", err)
	}

	// Noise pre-filter. Whisper hallucinates digits/quotes/single dots on
	// silence and noise — confidence pinpoints them (often <0.10).
	// Silencing text here keeps idx and timestamps but stops the trash
	// from polluting the LLM input AND the merged transcript. The list of
	// silenced idx is preserved so audit can surface "this track had N
	// noise segments — check the source recording quality".
	var noiseFilteredIdx []int
	for i := range raw.Segments {
		s := &raw.Segments[i]
		// Confidence-based filter: silence whisper hallucinations whose ASR
		// confidence falls below the configured threshold.
		if uc.NoiseFilterThreshold > 0 && s.Confidence > 0 && s.Confidence < uc.NoiseFilterThreshold {
			s.Text = ""
			noiseFilteredIdx = append(noiseFilteredIdx, s.Idx)
			continue
		}
		// Content-based filter: lone dots ("."), ellipses ("..."), digit /
		// symbol soup ("....-13, 201") and other near-empty fragments often
		// score confidence 0.25–0.5 (above the noise threshold) yet carry no
		// linguistic content. LLMs silently drop them from the response,
		// breaking idx-set validation and forcing the chunk into degraded
		// raw_with_razdel fallback. Silencing here keeps idx + timestamps but
		// removes the empty payload from the LLM input.
		if s.Text != "" && !hasMeaningfulContent(s.Text) {
			s.Text = ""
			noiseFilteredIdx = append(noiseFilteredIdx, s.Idx)
		}
	}

	chunkSize := opts.ChunkSize
	if chunkSize == 0 {
		chunkSize = uc.ChunkSize
	}
	if chunkSize == 0 {
		chunkSize = 50
	}
	overlap := opts.Overlap
	if overlap == 0 {
		overlap = uc.Overlap
	}
	if overlap == 0 {
		overlap = 4
	}
	retries := uc.Retries
	if retries < 0 {
		retries = 0
	}
	concurrency := opts.Concurrency
	if concurrency == 0 {
		concurrency = uc.Concurrency
	}
	if concurrency <= 0 {
		concurrency = 6
	}

	// Build chunks with overlap.
	chunks := pipelinereview.BuildChunks(raw.Segments, chunkSize, overlap)

	idxText := make(map[int]string, len(raw.Segments))
	idxEdgeDist := make(map[int]int, len(raw.Segments)) // higher = better (farther from chunk edge)
	for _, s := range raw.Segments {
		idxText[s.Idx] = s.Text
		idxEdgeDist[s.Idx] = -1
	}
	fallbackSet := map[int]struct{}{}

	// Pre-build prev_tail per chunk from RAW segments so chunks are independent
	// and can run in parallel. The prev_tail is read-only context for boundary
	// disambiguation; using raw text instead of the prior chunk's reviewed text
	// is equivalent for the LLM's purpose.
	chunkSegs := make([][]reviewport.ChunkSegment, len(chunks))
	prevTails := make([][]reviewport.ChunkSegment, len(chunks))
	for i, ck := range chunks {
		chunkSegs[i] = reviewport.ChunkSegmentsFromRaw(ck.Segs)
		if i == 0 {
			prevTails[i] = nil
		} else {
			prevTails[i] = pipelinereview.LastN(chunkSegs[i-1], overlap)
		}
	}

	type chunkResult struct {
		segs      []reviewport.ChunkSegment
		sentences [][]int // group raw idx into sentences
		fallback  []int   // idx set if review failed
		skipped   bool    // resumed from prior successful artifact
	}
	results := make([]chunkResult, len(chunks))

	// Resume by default: re-running transcript_review after a partial
	// timeout shouldn't re-pay for chunks already on disk. Caller can
	// flip ForceFullRerun=true to start clean.
	skipDone := !opts.ForceFullRerun

	// OnlyChunks restricts the run to specific chunk indices. Empty =
	// all chunks. Build the set once.
	onlyChunkSet := map[int]struct{}{}
	for _, idx := range opts.OnlyChunks {
		onlyChunkSet[idx] = struct{}{}
	}
	hasOnlyFilter := len(onlyChunkSet) > 0

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i := range chunks {
		i := i

		// Surgical re-run semantics: when caller restricts the run with
		// OnlyChunks, ForceFullRerun applies ONLY to chunks in that set —
		// untouched chunks always try disk first so they keep their prior
		// review (otherwise force=true would silently demote them all to
		// raw fallback).
		_, inOnlySet := onlyChunkSet[i]
		tryDisk := skipDone || (hasOnlyFilter && !inOnlySet)
		if tryDisk {
			if reused, ok := loadSucceededChunk(ctx, uc.Transcripts, id, language, i); ok {
				results[i] = chunkResult{
					segs:      reused.Response.Segments,
					sentences: reused.Response.Sentences,
					skipped:   true,
				}
				continue
			}
		}

		// Filter path: when caller restricted to specific chunk indices,
		// skip everything else. Their idx land in chunkResult.fallback so
		// the post-loop on line ~440 hoists them into fallbackSet — that
		// keeps res.FallbackIdx accurate even for chunks the operator
		// chose not to re-run.
		if hasOnlyFilter {
			if _, ok := onlyChunkSet[i]; !ok {
				fb := make([]int, 0, len(chunks[i].Segs))
				for _, s := range chunks[i].Segs {
					fb = append(fb, s.Idx)
				}
				results[i] = chunkResult{fallback: fb}
				continue
			}
		}

		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			req := reviewport.ChunkRequest{
				Language: language,
				Segments: chunkSegs[i],
				PrevTail: prevTails[i],
			}
			// Glossary RAG: scan the raw chunk text for canonical terms
			// the LLM should prefer. The hints rendered here become
			// req.ExtraPrompt and are persisted on the chunk artifact
			// verbatim so the LLM input is reproducible offline.
			if uc.Glossary != nil {
				thr := uc.GlossaryThreshold
				if thr <= 0 {
					thr = 0.55
				}
				maxH := uc.GlossaryMaxHints
				if maxH <= 0 {
					maxH = 10
				}
				rawText := pipelinereview.JoinChunkText(chunkSegs[i])
				if hints := uc.Glossary.RenderHints(rawText, language, thr, maxH); hints != "" {
					req.ExtraPrompt = hints
				}
			}
			startedAt := time.Now().UTC()

			// Walk the attempt chain. Each attempt = one reviewer (single or
			// hybrid). On audit / idx-set failure, fall through to the next.
			// Models[] from every superseded attempt is accumulated into
			// the final chunk artifact (with Outcome=attempt-superseded)
			// so cost and history are recorded fully.
			var attempt pipelinereview.ChunkAttempt
			var allRejected []reviewport.ModelEntry
			for _, reviewer := range attemptReviewers {
				attempt = pipelinereview.TryReview(ctx, reviewer, req, retries)
				if attempt.Err == nil {
					break
				}
				allRejected = append(allRejected, pipelinereview.TagOutcome(attempt.Final.Models, reviewport.OutcomeAttemptSuperseded, nil, attempt.Err.Error())...)
			}
			if len(allRejected) > 0 {
				attempt.Final.Models = append(append([]reviewport.ModelEntry{}, allRejected...), attempt.Final.Models...)
			}
			finishedAt := time.Now().UTC()

			// Persist per-chunk artifact for audit/debug — even when the chunk
			// fell back, we keep the (last) response so the failure can be
			// inspected after the fact.
			persistChunkArtifact(ctx, uc.Transcripts, id, language, i, chunks[i].Segs, req, attempt, startedAt, finishedAt)

			if attempt.Err != nil {
				fb := make([]int, 0, len(chunks[i].Segs))
				for _, s := range chunks[i].Segs {
					fb = append(fb, s.Idx)
				}
				results[i] = chunkResult{fallback: fb}
				return
			}
			results[i] = chunkResult{segs: attempt.Final.Segments, sentences: attempt.Final.Sentences}
		}()
	}
	wg.Wait()

	// Per raw idx: best-edge-distance verdict on whether this idx ends a sentence.
	boundaries := make([]pipelinereview.IdxBoundary, len(raw.Segments))
	idxToPos := make(map[int]int, len(raw.Segments))
	for i, s := range raw.Segments {
		idxToPos[s.Idx] = i
		boundaries[i].EdgeDist = -1
	}

	chunksRun := len(chunks)
	succeeded := 0
	for _, r := range results {
		if len(r.fallback) > 0 {
			for _, idx := range r.fallback {
				fallbackSet[idx] = struct{}{}
			}
			continue
		}
		succeeded++
		// Apply text edits with edge-distance preference.
		for i, s := range r.segs {
			distFromLeft := i
			distFromRight := len(r.segs) - 1 - i
			dist := pipelinereview.MinInt(distFromLeft, distFromRight)
			if dist > idxEdgeDist[s.Idx] {
				idxText[s.Idx] = s.Text
				idxEdgeDist[s.Idx] = dist
			}
		}
		// Apply sentence-end verdicts. Use right-edge distance (how much
		// context the model saw AFTER this idx) — that's what determines
		// whether a sentence-end verdict is reliable. A chunk that sees
		// more text after idx N has a better view of whether N closes a
		// sentence or the sentence continues into N+1.
		// Validate sentences cover the chunk's idx set; if not, ignore.
		endIdx, ok := pipelinereview.BuildEndSet(r.segs, r.sentences)
		if !ok {
			continue
		}
		for i, s := range r.segs {
			distRight := len(r.segs) - 1 - i
			rp, present := idxToPos[s.Idx]
			if !present {
				continue
			}
			if distRight > boundaries[rp].EdgeDist || !boundaries[rp].HasInfo {
				boundaries[rp].EdgeDist = distRight
				boundaries[rp].IsEnd = endIdx[s.Idx]
				boundaries[rp].HasInfo = true
			}
		}
	}

	// Optional razdel pass: when configured, override boundaries with
	// the deterministic sentence-aware splitter. Even if every chunk
	// review came back with broken sentence info, razdel reconstructs
	// boundaries from the corrected (or raw fallback) text.
	if uc.Splitter != nil {
		if newBoundaries, ok := pipelinereview.SplitWithRazdel(ctx, uc.Splitter, raw.Segments, idxText); ok {
			boundaries = newBoundaries
		}
	}

	// Force the very last raw segment to close the final sentence.
	if n := len(raw.Segments); n > 0 {
		boundaries[n-1].IsEnd = true
	}

	// Walk raw segments in order; emit one SentenceBlock per detected sentence.
	// If a chunk gave no sentence info for an idx (e.g. all chunks failed for it),
	// fall back to "one segment = one sentence" so we never silently drop content.
	blocks := make([]transcript.Block, 0, len(raw.Segments))
	var (
		curStart  int64
		curParts  []string
		curOpen   bool
	)
	for i, s := range raw.Segments {
		if !curOpen {
			curStart = s.Start
			curParts = curParts[:0]
			curOpen = true
		}
		if t := strings.TrimSpace(idxText[s.Idx]); t != "" {
			curParts = append(curParts, t)
		}
		closeNow := boundaries[i].IsEnd || !boundaries[i].HasInfo
		if closeNow {
			blocks = append(blocks, transcript.SentenceBlock{
				Start: curStart,
				End:   s.End,
				Text:  strings.Join(curParts, " "),
			})
			curOpen = false
		}
	}
	// Safety: should never trigger because we forced isEnd on the last segment.
	if curOpen && len(raw.Segments) > 0 {
		last := raw.Segments[len(raw.Segments)-1]
		blocks = append(blocks, transcript.SentenceBlock{
			Start: curStart,
			End:   last.End,
			Text:  strings.Join(curParts, " "),
		})
	}
	reviewed := transcript.Reviewed{
		TrackId:  string(id),
		Language: language,
		Version:  1,
		Blocks:   blocks,
	}
	if err := uc.Transcripts.WriteReviewed(ctx, reviewed); err != nil {
		return Result{}, err
	}

	// Persist review session metadata to artifacts/.../{lang}/review.json.
	agg := aggregateModels(ctx, uc.Transcripts, id, language, len(chunks), uc.LowConfThreshold)

	res = Result{
		TrackId:      id,
		Language:     language,
		Models:       models,
		ChunksRun:    chunksRun,
		Succeeded:    succeeded,
		Fallback:     len(fallbackSet),
		Blocks:       len(blocks),
		TotalCostUSD: agg.TotalCostUSD,
	}
	for idx := range fallbackSet {
		res.FallbackIdx = append(res.FallbackIdx, idx)
	}
	sort.Ints(res.FallbackIdx)

	sessionPayload := map[string]any{
		"track_id":             string(id),
		"language":             language,
		"models":               models,
		"chunk_size":           chunkSize,
		"overlap":              overlap,
		"concurrency":          concurrency,
		"chunks_run":           chunksRun,
		"succeeded":            succeeded,
		"fallback":             len(fallbackSet),
		"fallback_idx":         res.FallbackIdx,
		"raw_segments":         len(raw.Segments),
		"noise_filtered_idx":   noiseFilteredIdx,
		"noise_filter_threshold": uc.NoiseFilterThreshold,
		"reviewed_at":          time.Now().UTC().Format(time.RFC3339),
		"total_cost_usd":      agg.TotalCostUSD,
		"cost_by_model_usd":   agg.CostByModel,
		"tokens_by_model":     agg.TokensByModel,
		"models_distribution": agg.ModelsDistribution,
		"low_conf_chunks":     agg.LowConfChunks,
		"chunk_audit_flags":   agg.ChunkAuditFlags,
		"degraded_chunks":     agg.DegradedChunks,
	}
	sessionBody, _ := json.MarshalIndent(sessionPayload, "", "  ")
	_ = uc.Transcripts.WriteReviewSession(ctx, id, language, sessionBody)

	resBody, _ := json.Marshal(res)
	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, resBody, ""); err != nil {
		return Result{}, err
	}
	return res, nil
}

// hasMeaningfulContent reports whether text contains at least 2 letter
// characters (any script). Whisper hallucinations on silence and noise
// surface as a lone dot, ellipsis, "....-13, 201" digit-soup, or stray
// quotes — strings that count zero letters and confuse LLM idx-validators.
// Two-letter floor avoids tripping on real short words like "Я" or "и".
func hasMeaningfulContent(text string) bool {
	letters := 0
	for _, r := range text {
		if unicode.IsLetter(r) {
			letters++
			if letters >= 2 {
				return true
			}
		}
	}
	return false
}
