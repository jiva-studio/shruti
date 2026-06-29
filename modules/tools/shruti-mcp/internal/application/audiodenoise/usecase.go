// Package audiodenoise produces the denoised "clean" mp3 for a committed track
// and registers it as a track_audio kind=clean row, so the app can offer the
// original↔clean source-mix. Mirrors the normalize/audiotag local-tool pattern:
// it works on the on-disk out/ tree; the asset-push pipeline ships clean.mp3 to
// S3 the same way it ships original.mp3.
package audiodenoise

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/denoiseplan"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	denoiserport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/denoiser"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

type UseCase struct {
	Audio    audioport.Store
	Probe    audioport.Probe
	Denoiser denoiserport.Denoiser
	Catalog  catalogport.CommitRepository
	// Transcripts is optional: when set, the EN transcript is used to detect
	// sung kirtan / recited regions and protect them from the speech denoiser
	// via a splice plan. Nil (or no transcript on disk) → plain whole-file.
	Transcripts transcriptport.Store
}

type Result struct {
	TrackId    track.Id `json:"track_id"`
	Language   string   `json:"language"`
	CleanPath  string   `json:"clean_path"`
	DurationMs int64    `json:"duration_ms"`
	SizeBytes  int64    `json:"size_bytes"`
	// Spliced reports whether a kirtan-aware splice plan was applied (vs plain
	// whole-file denoise); Segments is the plan's segment count when spliced.
	Spliced  bool `json:"spliced"`
	Segments int  `json:"segments,omitempty"`
}

// Run denoises out/public/tracks/{id}/audio/original.mp3 → clean.mp3, probes it,
// and upserts a track_audio kind=clean row for (id, language) pointing at the
// canonical relative key. When the transcript reveals sung kirtan / recited
// regions it applies a splice plan (afftdn over those, deepfilternet over
// speech) instead of mangling them whole-file. Idempotent: re-running
// overwrites the file + row.
func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (Result, error) {
	in := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)
	out := uc.Audio.PublicAudioPath(id, audioport.VersionClean)

	plan := uc.buildPlan(ctx, id, language, in)
	if len(plan) > 0 {
		if err := uc.Denoiser.DenoisePlan(ctx, in, out, plan, denoiseplan.CrossfadeMs); err != nil {
			return Result{}, err
		}
	} else if err := uc.Denoiser.Denoise(ctx, in, out); err != nil {
		return Result{}, err
	}
	info, err := uc.Probe.Probe(ctx, out)
	if err != nil {
		return Result{}, fmt.Errorf("probe clean: %w", err)
	}

	relPath := fmt.Sprintf("public/tracks/%s/audio/clean.mp3", string(id))
	row := catalog.AudioRow{
		TrackID:  string(id),
		Language: language,
		Kind:     catalog.AudioKindClean,
		Path:     relPath,
		Filesize: info.SizeBytes,
		Duration: info.DurationMs,
	}
	if err := uc.Catalog.UpsertAudio(ctx, row); err != nil {
		return Result{}, fmt.Errorf("register clean audio: %w", err)
	}

	return Result{
		TrackId:    id,
		Language:   language,
		CleanPath:  relPath,
		DurationMs: info.DurationMs,
		SizeBytes:  info.SizeBytes,
		Spliced:    len(plan) > 0,
		Segments:   len(plan),
	}, nil
}

// buildPlan reads the EN transcript and the source duration to detect kirtan /
// recitation regions. Returns nil (→ plain whole-file denoise) when no
// transcript is configured/on disk, the duration can't be probed, or the track
// has no protectable regions.
func (uc UseCase) buildPlan(ctx context.Context, id track.Id, language, inPath string) []denoiseplan.Segment {
	if uc.Transcripts == nil {
		return nil
	}
	raw, err := uc.Transcripts.ReadRaw(ctx, id, language)
	if err != nil {
		return nil
	}
	info, err := uc.Probe.Probe(ctx, inPath)
	if err != nil {
		return nil
	}
	return denoiseplan.Build(raw.Segments, info.DurationMs)
}
