package auditreview

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

// TrackOptions selects one track + language for the per-track audit.
type TrackOptions struct {
	TrackId      track.Id
	Language     string
	LowConfLimit float64 // segments below this confidence are listed; 0 = use 0.70
}

// SegmentReport surfaces one suspicious raw segment so the caller can see
// at-a-glance what the LLM had to work with for a low-conf island.
type SegmentReport struct {
	Idx        int     `json:"idx"`
	RawText    string  `json:"raw_text"`
	Reviewed   string  `json:"reviewed_text,omitempty"`
	Confidence float64 `json:"confidence"`
}

// ChunkReport is one row in the per-track audit. Only chunks with at
// least one issue (failed, flagged, or carrying low-conf segments) make
// it into the response.
type ChunkReport struct {
	ChunkIndex      int             `json:"chunk_index"`
	FirstIdx        int             `json:"first_idx"`
	LastIdx         int             `json:"last_idx"`
	OK              bool            `json:"ok"`
	Error           string          `json:"error,omitempty"`
	Degraded        string          `json:"degraded,omitempty"`
	AuditFlags      []string        `json:"audit_flags,omitempty"`
	LowConfSegments []SegmentReport `json:"low_conf_segments,omitempty"`
	Models          []string        `json:"models,omitempty"` // role:name
	CostUSD         float64         `json:"cost_usd,omitempty"`
}

type TrackResult struct {
	TrackId        string        `json:"track_id"`
	Language       string        `json:"language"`
	ChunksTotal    int           `json:"chunks_total"`
	FallbackChunks []int         `json:"fallback_chunks,omitempty"`
	FlaggedChunks  []int         `json:"flagged_chunks,omitempty"`
	DegradedChunks []int         `json:"degraded_chunks,omitempty"`
	LowConfChunks  []int         `json:"low_conf_chunks,omitempty"`
	TotalCostUSD   float64       `json:"total_cost_usd"`
	Chunks         []ChunkReport `json:"chunks"`
	SuggestedFix   string        `json:"suggested_fix,omitempty"`
}

// chunkArtifact mirrors the on-disk shape from
// internal/application/review/usecase.go but holds only the fields the
// audit needs. Defining it locally avoids re-exporting an internal
// type from another package.
type chunkArtifact struct {
	ChunkIndex int    `json:"chunk_index"`
	FirstIdx   int    `json:"first_idx"`
	LastIdx    int    `json:"last_idx"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	Degraded   string `json:"degraded,omitempty"`
	Models     []struct {
		Role    string  `json:"role"`
		Name    string  `json:"name"`
		ModelID string  `json:"model_id"`
		CostUSD float64 `json:"cost_usd"`
	} `json:"models"`
	Request struct {
		Segments []struct {
			Idx        int     `json:"idx"`
			Text       string  `json:"text"`
			Confidence float64 `json:"confidence"`
		} `json:"segments"`
	} `json:"request"`
	Response struct {
		Segments []struct {
			Idx  int    `json:"idx"`
			Text string `json:"text"`
		} `json:"segments"`
		AuditFlags []string `json:"audit_flags"`
	} `json:"response"`
}

func (uc UseCase) RunTrack(ctx context.Context, opts TrackOptions) (TrackResult, error) {
	if opts.Language == "" {
		return TrackResult{}, fmt.Errorf("audit_track: language is required")
	}
	threshold := opts.LowConfLimit
	if threshold <= 0 {
		threshold = 0.70
	}

	res := TrackResult{
		TrackId:  string(opts.TrackId),
		Language: opts.Language,
	}

	// Walk chunk_NNNN.json by index until we hit ENOENT — chunks are
	// dense (no gaps) by construction.
	for i := 0; ; i++ {
		body, err := uc.Transcripts.ReadReviewChunk(ctx, opts.TrackId, opts.Language, i)
		if err != nil || len(body) == 0 {
			break
		}
		var rec chunkArtifact
		if err := json.Unmarshal(body, &rec); err != nil {
			break
		}
		res.ChunksTotal++

		report := ChunkReport{
			ChunkIndex: rec.ChunkIndex,
			FirstIdx:   rec.FirstIdx,
			LastIdx:    rec.LastIdx,
			OK:         rec.OK,
			Error:      rec.Error,
			Degraded:   rec.Degraded,
			AuditFlags: append([]string{}, rec.Response.AuditFlags...),
		}
		for _, m := range rec.Models {
			report.Models = append(report.Models, m.Role+":"+m.Name)
			report.CostUSD += m.CostUSD
		}
		res.TotalCostUSD += report.CostUSD

		reviewedByIdx := map[int]string{}
		for _, s := range rec.Response.Segments {
			reviewedByIdx[s.Idx] = s.Text
		}
		hasLowConf := false
		for _, s := range rec.Request.Segments {
			if s.Confidence > 0 && s.Confidence < threshold {
				hasLowConf = true
				report.LowConfSegments = append(report.LowConfSegments, SegmentReport{
					Idx:        s.Idx,
					RawText:    s.Text,
					Reviewed:   reviewedByIdx[s.Idx],
					Confidence: s.Confidence,
				})
			}
		}

		if !rec.OK {
			res.FallbackChunks = append(res.FallbackChunks, rec.ChunkIndex)
		}
		if len(report.AuditFlags) > 0 {
			res.FlaggedChunks = append(res.FlaggedChunks, rec.ChunkIndex)
		}
		if rec.Degraded != "" {
			res.DegradedChunks = append(res.DegradedChunks, rec.ChunkIndex)
		}
		if hasLowConf {
			res.LowConfChunks = append(res.LowConfChunks, rec.ChunkIndex)
		}
		// Only emit chunks that need attention; clean ones bloat the
		// response without adding signal.
		if !rec.OK || rec.Degraded != "" || len(report.AuditFlags) > 0 || hasLowConf {
			res.Chunks = append(res.Chunks, report)
		}
	}

	if res.ChunksTotal == 0 {
		return TrackResult{}, fmt.Errorf("audit_track: no chunk artifacts found for %s/%s", opts.TrackId, opts.Language)
	}

	// Suggested fix: only if anything actually warrants premium re-run.
	candidates := append([]int{}, res.FallbackChunks...)
	candidates = append(candidates, res.FlaggedChunks...)
	candidates = append(candidates, res.DegradedChunks...)
	candidates = uniqueSortedInts(candidates)
	if len(candidates) > 0 {
		res.SuggestedFix = fmt.Sprintf(
			`transcript_review track_id=%s language=%s models="gemini-3.1-flash-lite,gemini-3.1-pro-preview" only_chunks="%s" force_full_rerun=true`,
			opts.TrackId, opts.Language, intsCSV(candidates),
		)
	}

	return res, nil
}

func uniqueSortedInts(in []int) []int {
	if len(in) == 0 {
		return nil
	}
	seen := map[int]struct{}{}
	out := make([]int, 0, len(in))
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	sort.Ints(out)
	return out
}

func intsCSV(in []int) string {
	parts := make([]string, len(in))
	for i, v := range in {
		parts[i] = fmt.Sprintf("%d", v)
	}
	return strings.Join(parts, ",")
}
