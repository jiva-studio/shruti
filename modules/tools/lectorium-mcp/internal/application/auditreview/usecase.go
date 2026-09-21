// Package auditreview walks the on-disk review artifacts and reports
// per-track health: tracks where chunks fell back to raw text, tracks
// where the audit-flag detector flagged content-level anomalies, and
// the most expensive runs. Used by the audit_review MCP tool to surface
// the few hundred lectures (out of thousands) that need a human or
// premium re-run after a corpus-wide baseline pass.
package auditreview

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"sort"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	lakeport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
)

type UseCase struct {
	Registry    lakeport.Registry
	Transcripts transcriptport.Store
}

// Candidate identifies one (track, language) pair the audit should
// inspect. Resolved upstream from a track.Selector by the MCP tool.
type Candidate struct {
	TrackID  track.ID
	Language string
}

type Options struct {
	// Candidates is the set of tracks to audit. Empty means "every track
	// in the registry that has a reviewed:done stage" — preserves the
	// original whole-corpus behaviour.
	Candidates []Candidate
	// Top: when >0, return at most this many tracks (worst first).
	Top int
}

// TrackReport is the per-track summary surfaced by the audit. Only tracks
// with at least one issue (Fallback>0 OR FlaggedChunksCount>0) make it
// into the response — clean tracks are counted but not enumerated.
type TrackReport struct {
	TrackID             string           `json:"track_id"`
	Language            string           `json:"language"`
	Models              []string         `json:"models,omitempty"`
	ChunksRun           int              `json:"chunks_run"`
	Succeeded           int              `json:"succeeded"`
	Fallback            int              `json:"fallback"`
	FlaggedChunksCount  int              `json:"flagged_chunks_count"`
	FlaggedChunks       map[int][]string `json:"flagged_chunks,omitempty"`
	LowConfChunks       []int            `json:"low_conf_chunks,omitempty"`
	DegradedChunks      []int            `json:"degraded_chunks,omitempty"`
	DegradedChunksCount int              `json:"degraded_chunks_count"`
	// NoiseFilteredCount is how many raw segments were silenced by the
	// pre-LLM noise filter (whisper hallucinations on noise/silence).
	// A high count signals the source recording is low-quality and may
	// need manual inspection.
	NoiseFilteredCount int     `json:"noise_filtered_count,omitempty"`
	TotalCostUSD       float64 `json:"total_cost_usd,omitempty"`
}

type Result struct {
	TotalTracks        int            `json:"total_tracks"`
	CleanTracks        int            `json:"clean_tracks"`
	TracksWithFallback int            `json:"tracks_with_fallback"`
	TracksWithFlags    int            `json:"tracks_with_flags"`
	TracksWithDegraded int            `json:"tracks_with_degraded"`
	TotalCostUSD       float64        `json:"total_cost_usd"`
	FlagsHistogram     map[string]int `json:"flags_histogram,omitempty"`
	TopOffenders       []TrackReport  `json:"top_offenders"`
}

func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	res := Result{FlagsHistogram: map[string]int{}}

	// Resolve the candidate list. With Candidates set, that's our only
	// input — caller (typically MCP audit_review) has already filtered
	// via track.Selector. Without it, fall back to the legacy whole-
	// corpus walk so unit tests and ad-hoc invocations keep working.
	candidates := opts.Candidates
	if len(candidates) == 0 {
		var err error
		candidates, err = uc.allReviewedTracks(ctx)
		if err != nil {
			return Result{}, err
		}
	}

	for _, c := range candidates {
		if c.Language == "" {
			continue
		}
		report, ok := uc.loadTrackReport(ctx, c.TrackID, c.Language)
		if !ok {
			continue
		}
		res.TotalTracks++
		res.TotalCostUSD += report.TotalCostUSD

		problems := report.Fallback > 0 || report.FlaggedChunksCount > 0 || report.DegradedChunksCount > 0
		if !problems {
			res.CleanTracks++
			continue
		}
		if report.Fallback > 0 {
			res.TracksWithFallback++
		}
		if report.FlaggedChunksCount > 0 {
			res.TracksWithFlags++
		}
		if report.DegradedChunksCount > 0 {
			res.TracksWithDegraded++
		}
		for _, flagList := range report.FlaggedChunks {
			for _, flag := range flagList {
				res.FlagsHistogram[flag]++
			}
		}
		res.TopOffenders = append(res.TopOffenders, report)
	}

	sort.Slice(res.TopOffenders, func(i, j int) bool {
		// Severity score: degraded > fallback > flags. Degraded chunks
		// rely on raw text and razdel boundaries — that's the most
		// urgent thing to fix.
		score := func(r TrackReport) int {
			return r.DegradedChunksCount*100 + r.Fallback*10 + r.FlaggedChunksCount
		}
		si, sj := score(res.TopOffenders[i]), score(res.TopOffenders[j])
		if si != sj {
			return si > sj
		}
		return res.TopOffenders[i].TrackID < res.TopOffenders[j].TrackID
	})
	if opts.Top > 0 && len(res.TopOffenders) > opts.Top {
		res.TopOffenders = res.TopOffenders[:opts.Top]
	}
	return res, nil
}

// allReviewedTracks scans the registry for every track with a
// reviewed:done stage. Backstop for callers that don't pre-resolve via
// track.Selector — keeps the legacy "audit everything" behaviour.
func (uc UseCase) allReviewedTracks(ctx context.Context) ([]Candidate, error) {
	out := []Candidate{}
	cursor := ""
	for {
		batch, next, err := uc.Registry.Scan(ctx, 200, cursor)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		for _, f := range batch {
			lang := pickLanguageFromStages(f.Stages)
			if !hasReviewedDone(f.Stages, lang) {
				continue
			}
			out = append(out, Candidate{TrackID: f.ID, Language: lang})
		}
		if next == "" {
			break
		}
		cursor = next
	}
	return out, nil
}

func pickLanguageFromStages(stages []lakeport.StageRow) string {
	for _, s := range stages {
		if s.Key.Stage == pipeline.StageReviewed && s.Status == pipeline.StatusDone {
			return s.Key.Variant
		}
	}
	for _, s := range stages {
		if s.Key.Stage == pipeline.StageTranscribed && s.Status == pipeline.StatusDone {
			return s.Key.Variant
		}
	}
	return ""
}

func hasReviewedDone(stages []lakeport.StageRow, language string) bool {
	if language == "" {
		return false
	}
	for _, s := range stages {
		if s.Key.Stage == pipeline.StageReviewed && s.Key.Variant == language && s.Status == pipeline.StatusDone {
			return true
		}
	}
	return false
}

// sessionShape is the trimmed projection of review.json that the audit
// reads. Field tags mirror the writer in application/review/usecase.go.
type sessionShape struct {
	TrackID          string              `json:"track_id"`
	Language         string              `json:"language"`
	Models           []string            `json:"models"`
	ChunksRun        int                 `json:"chunks_run"`
	Succeeded        int                 `json:"succeeded"`
	Fallback         int                 `json:"fallback"`
	LowConfChunks    []int               `json:"low_conf_chunks"`
	ChunkAuditFlags  map[string][]string `json:"chunk_audit_flags"`
	DegradedChunks   []int               `json:"degraded_chunks"`
	NoiseFilteredIdx []int               `json:"noise_filtered_idx"`
	TotalCostUSD     float64             `json:"total_cost_usd"`
}

func (uc UseCase) loadTrackReport(ctx context.Context, id track.ID, language string) (TrackReport, bool) {
	body, err := uc.Transcripts.ReadReviewSession(ctx, id, language)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, os.ErrNotExist) {
			return TrackReport{}, false
		}
		return TrackReport{}, false
	}
	var raw sessionShape
	if err := json.Unmarshal(body, &raw); err != nil {
		return TrackReport{}, false
	}
	flagged := map[int][]string{}
	for k, v := range raw.ChunkAuditFlags {
		var idx int
		if _, err := jsonNumberKey(k, &idx); err != nil {
			continue
		}
		flagged[idx] = append([]string{}, v...)
	}
	return TrackReport{
		TrackID:             string(id),
		Language:            language,
		Models:              raw.Models,
		ChunksRun:           raw.ChunksRun,
		Succeeded:           raw.Succeeded,
		Fallback:            raw.Fallback,
		FlaggedChunksCount:  len(flagged),
		FlaggedChunks:       flagged,
		LowConfChunks:       raw.LowConfChunks,
		DegradedChunks:      raw.DegradedChunks,
		DegradedChunksCount: len(raw.DegradedChunks),
		NoiseFilteredCount:  len(raw.NoiseFilteredIdx),
		TotalCostUSD:        raw.TotalCostUSD,
	}, true
}

// jsonNumberKey parses a JSON-object string key as an int. JSON only
// allows string keys, so the writer encodes `chunk_audit_flags` with
// stringified indices ("1", "4", …) — this turns them back to int.
func jsonNumberKey(key string, out *int) (string, error) {
	*out = 0
	for _, r := range key {
		if r < '0' || r > '9' {
			return "", errors.New("non-digit key")
		}
		*out = *out*10 + int(r-'0')
	}
	return key, nil
}
