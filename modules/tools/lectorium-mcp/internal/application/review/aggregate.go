package review

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
)

type chunkArtifact struct {
	ChunkIndex int                     `json:"chunk_index"`
	Language   string                  `json:"language"`
	Models     []reviewport.ModelEntry `json:"models,omitempty"`
	Provider   string                  `json:"provider,omitempty"` // legacy, read-only
	FirstIdx   int                     `json:"first_idx"`
	LastIdx    int                     `json:"last_idx"`
	OK         bool                    `json:"ok"`
	Error      string                  `json:"error,omitempty"`
	// Degraded marks the chunk's actual state on disk when it could not
	// produce a clean LLM-reviewed result. Empty when the chunk is fine.
	// Currently the only value is "raw_with_razdel": every attempt
	// failed (idx mismatch / audit gate / transport), so the merged
	// transcript will use the raw whisper text for these segments and
	// rely on the razdel splitter for sentence boundaries.
	Degraded   string                   `json:"degraded,omitempty"`
	StartedAt  time.Time                `json:"started_at"`
	FinishedAt time.Time                `json:"finished_at"`
	Request    reviewport.ChunkRequest  `json:"request"`
	Response   reviewport.ChunkResponse `json:"response"`
}

const DegradedRawWithRazdel = "raw_with_razdel"

type tokenSums struct {
	In        int64 `json:"in"`
	Out       int64 `json:"out"`
	Reasoning int64 `json:"reasoning,omitempty"`
}

type sessionAggregate struct {
	TotalCostUSD       float64
	CostByModel        map[string]float64
	TokensByModel      map[string]tokenSums
	ModelsDistribution map[string]int
	LowConfChunks      []int
	// ChunkAuditFlags maps chunk_index → list of audit flag identifiers
	// found by DetectAuditFlags. Empty if all chunks looked clean.
	ChunkAuditFlags map[int][]string
	// DegradedChunks lists chunks whose final state on disk is
	// "raw_with_razdel": every LLM attempt was rejected and the chunk's
	// segments rely on raw whisper text + razdel boundaries.
	DegradedChunks []int
}

// aggregateModels reads every chunk_NNNN.json and produces the per-session
// aggregates that the consumer review.json needs:
//   - total cost in USD
//   - cost broken down per model_id
//   - in/out/reasoning tokens per model_id
//   - count of chunks where each model_id contributed
//   - chunk indices that contain at least one segment with confidence below threshold
//     (handy to know "where might premium re-run be useful")
//
// Tolerates missing/legacy artifacts — they just contribute no metrics.
func aggregateModels(ctx context.Context, store transcriptport.Store, id track.Id, language string, totalChunks int, threshold float64) sessionAggregate {
	agg := sessionAggregate{
		CostByModel:        map[string]float64{},
		TokensByModel:      map[string]tokenSums{},
		ModelsDistribution: map[string]int{},
		ChunkAuditFlags:    map[int][]string{},
	}
	if store == nil {
		return agg
	}
	for i := 0; i < totalChunks; i++ {
		body, err := store.ReadReviewChunk(ctx, id, language, i)
		if err != nil || len(body) == 0 {
			continue
		}
		var rec chunkArtifact
		if err := json.Unmarshal(body, &rec); err != nil {
			continue
		}
		seenInChunk := map[string]struct{}{}
		for _, m := range rec.Models {
			if m.ModelID == "" {
				continue
			}
			agg.TotalCostUSD += m.CostUSD
			agg.CostByModel[m.ModelID] += m.CostUSD
			ts := agg.TokensByModel[m.ModelID]
			ts.In += m.TokensIn
			ts.Out += m.TokensOut
			ts.Reasoning += m.ReasoningTokens
			agg.TokensByModel[m.ModelID] = ts
			if _, ok := seenInChunk[m.ModelID]; !ok {
				agg.ModelsDistribution[m.ModelID]++
				seenInChunk[m.ModelID] = struct{}{}
			}
		}
		// Inspect request segments for low-confidence flag — premium re-run
		// candidates. Threshold mirrors hybrid's policy.
		if threshold > 0 {
			for _, s := range rec.Request.Segments {
				if s.Confidence > 0 && s.Confidence < threshold {
					agg.LowConfChunks = append(agg.LowConfChunks, rec.ChunkIndex)
					break
				}
			}
		}
		if len(rec.Response.AuditFlags) > 0 {
			agg.ChunkAuditFlags[rec.ChunkIndex] = append([]string{}, rec.Response.AuditFlags...)
		}
		if rec.Degraded != "" {
			agg.DegradedChunks = append(agg.DegradedChunks, rec.ChunkIndex)
		}
	}
	sort.Ints(agg.LowConfChunks)
	sort.Ints(agg.DegradedChunks)
	return agg
}

// loadSucceededChunk reads chunk_NNNN.json and returns the parsed
// artifact when it exists with ok=true. The boolean is false on any
// failure (missing file, parse error, ok=false) — the caller falls back
// to the live LLM path.
func loadSucceededChunk(ctx context.Context, store transcriptport.Store, id track.Id, language string, chunkIndex int) (chunkArtifact, bool) {
	if store == nil {
		return chunkArtifact{}, false
	}
	body, err := store.ReadReviewChunk(ctx, id, language, chunkIndex)
	if err != nil || len(body) == 0 {
		return chunkArtifact{}, false
	}
	var rec chunkArtifact
	if err := json.Unmarshal(body, &rec); err != nil {
		return chunkArtifact{}, false
	}
	if !rec.OK {
		return chunkArtifact{}, false
	}
	return rec, true
}

func persistChunkArtifact(
	ctx context.Context,
	store transcriptport.Store,
	id track.Id,
	language string,
	chunkIndex int,
	segs []transcript.RawSegment,
	req reviewport.ChunkRequest,
	att chunkAttempt,
	startedAt, finishedAt time.Time,
) {
	if store == nil || len(segs) == 0 {
		return
	}
	record := chunkArtifact{
		ChunkIndex: chunkIndex,
		Language:   language,
		Models:     att.final.Models,
		FirstIdx:   segs[0].Idx,
		LastIdx:    segs[len(segs)-1].Idx,
		OK:         att.err == nil,
		StartedAt:  startedAt,
		FinishedAt: finishedAt,
		Request:    req,
		Response:   att.final,
	}
	if att.err != nil {
		record.Error = att.err.Error()
		record.Degraded = DegradedRawWithRazdel
	}
	body, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return
	}
	_ = store.WriteReviewChunk(ctx, id, language, chunkIndex, body)
}
