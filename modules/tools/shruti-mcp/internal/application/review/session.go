package review

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
)

// session is what a run records in review.json beyond its Result.
type session struct {
	chunkSize        int
	overlap          int
	concurrency      int
	rawSegments      int
	noiseFilteredIdx []int
	agg              sessionAggregate
}

// writeSession records the run in artifacts/.../{lang}/review.json: its
// settings, the silenced noise segments (so an audit can flag a poor source
// recording), and the cost and quality aggregated over the chunk artifacts.
func (uc UseCase) writeSession(ctx context.Context, res Result, s session) error {
	body, err := json.MarshalIndent(map[string]any{
		"track_id":               string(res.TrackID),
		"language":               res.Language,
		"models":                 res.Models,
		"chunk_size":             s.chunkSize,
		"overlap":                s.overlap,
		"concurrency":            s.concurrency,
		"chunks_run":             res.ChunksRun,
		"succeeded":              res.Succeeded,
		"fallback":               res.Fallback,
		"fallback_idx":           res.FallbackIdx,
		"raw_segments":           s.rawSegments,
		"noise_filtered_idx":     s.noiseFilteredIdx,
		"noise_filter_threshold": uc.NoiseFilterThreshold,
		"reviewed_at":            uc.Clock.Now().UTC().Format(time.RFC3339),
		"total_cost_usd":         s.agg.TotalCostUSD,
		"cost_by_model_usd":      s.agg.CostByModel,
		"tokens_by_model":        s.agg.TokensByModel,
		"models_distribution":    s.agg.ModelsDistribution,
		"low_conf_chunks":        s.agg.LowConfChunks,
		"chunk_audit_flags":      s.agg.ChunkAuditFlags,
		"degraded_chunks":        s.agg.DegradedChunks,
	}, "", "  ")
	if err != nil {
		return fmt.Errorf("encode review session: %w", err)
	}
	if err := uc.Transcripts.WriteReviewSession(ctx, res.TrackID, res.Language, body); err != nil {
		return fmt.Errorf("write review session: %w", err)
	}
	return nil
}

// markDone records the result as the stage's payload.
func (uc UseCase) markDone(ctx context.Context, id track.ID, key pipeline.Key, res Result) error {
	body, err := json.Marshal(res)
	if err != nil {
		return fmt.Errorf("encode review result: %w", err)
	}
	return uc.Registry.SetStage(ctx, id, key, pipeline.StatusDone, body, "")
}
