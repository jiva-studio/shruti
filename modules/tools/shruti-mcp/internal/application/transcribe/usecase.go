package transcribe

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/application/stagefail"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/track"
	audioport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	lakeport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/transcriber"
	transcriptport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

type UseCase struct {
	Registry     lakeport.Registry
	Audio        audioport.Store
	Transcripts  transcriptport.Store
	Transcribers transcriber.Registry
}

type Options struct {
	Provider string // empty = registry default
	Model    string // empty = provider default
}

type Result struct {
	TrackId  track.Id `json:"track_id"`
	Language string   `json:"language"`
	Provider string   `json:"provider"`
	Segments int      `json:"segments"`
	Empty    bool     `json:"empty,omitempty"`
}

func (uc UseCase) Run(ctx context.Context, id track.Id, language string, opts Options) (res Result, rerr error) {
	stageKey := pipeline.Key{Stage: pipeline.StageTranscribed, Variant: language}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("transcribe: another worker holds stage for %s/%s", id, language)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	tx, err := uc.resolveProvider(opts.Provider)
	if err != nil {
		return Result{}, err
	}

	audioPath := uc.Audio.PublicAudioPath(id)
	raw, err := tx.Transcribe(ctx, audioPath, transcriber.Options{Language: language, Model: opts.Model})
	if err != nil {
		return Result{}, err
	}
	raw.TrackId = string(id)
	raw.Language = language

	if err := uc.Transcripts.WriteRaw(ctx, id, language, raw); err != nil {
		return Result{}, err
	}

	res = Result{
		TrackId:  id,
		Language: language,
		Provider: tx.Name(),
		Segments: len(raw.Segments),
		Empty:    len(raw.Segments) == 0,
	}
	body, _ := json.Marshal(res)
	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, body, ""); err != nil {
		return Result{}, err
	}
	return res, nil
}

func (uc UseCase) resolveProvider(name string) (transcriber.Transcriber, error) {
	if name != "" {
		t, ok := uc.Transcribers.Get(name)
		if !ok {
			return nil, fmt.Errorf("transcribe: provider %q not registered", name)
		}
		return t, nil
	}
	t := uc.Transcribers.Default()
	if t == nil {
		return nil, fmt.Errorf("transcribe: no providers registered")
	}
	return t, nil
}

