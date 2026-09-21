// Package normalize brings a track's audio to the target loudness.
package normalize

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/loudness"
)

type UseCase struct {
	Registry   lakeport.Registry
	Audio      audioport.Store
	Normalizer loudness.Normalizer
}

// Run re-encodes the source mp3 to canonical 128k CBR LAME and writes to public/.
func (uc UseCase) Run(ctx context.Context, id track.ID) (rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageNormalized}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return err
	}
	if !claimed {
		return fmt.Errorf("normalize: another worker holds stage for %s", id)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	in := uc.Audio.SourceArtifactPath(id)
	out := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)

	report, err := uc.Normalizer.Normalize(ctx, in, out)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(struct {
		BitrateK   int   `json:"bitrate_kbps"`
		DurationMs int64 `json:"duration_ms"`
	}{report.Bitrate, report.DurationMs})
	return uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, payload, "")
}
