package transcribe

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/stagefail"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	audioport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/audio"
	lakeport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
	"github.com/jiva-studio/lectorium/pipeline/ports/transcriber"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
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
	// Languages is every language written for this track, one transcript each.
	Languages []string `json:"languages,omitempty"`
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

	audioPath := uc.Audio.PublicAudioPath(id, audioport.VersionOriginal)
	raw, err := tx.Transcribe(ctx, audioPath, transcriber.Options{Language: language, Model: opts.Model})
	if err != nil {
		return Result{}, err
	}
	// A provider that tags segments per language (Deepgram multi) can return a
	// recording that is two transcripts in one — a talk and its consecutive
	// translation. Store each language separately so every transcript is
	// monolingual and gets reviewed by the model for its language.
	groups := transcript.SplitByLanguage(raw.Segments, language)
	langs := transcript.OrderedLanguages(groups, language)

	for _, lang := range langs {
		if lang != language {
			key := pipeline.Key{Stage: pipeline.StageTranscribed, Variant: lang}
			claimed, err := uc.Registry.TryClaimStage(ctx, id, key)
			if err != nil {
				return Result{}, err
			}
			if !claimed {
				return Result{}, fmt.Errorf("transcribe: another worker holds stage for %s/%s", id, lang)
			}
		}
		part := transcript.Raw{
			TrackId:  string(id),
			Language: lang,
			Provider: raw.Provider,
			Model:    raw.Model,
			Segments: transcript.Reindex(groups[lang]),
		}
		if err := uc.Transcripts.WriteRaw(ctx, id, lang, part); err != nil {
			return Result{}, err
		}
		if lang == language {
			continue
		}
		body, _ := json.Marshal(Result{
			TrackId: id, Language: lang, Provider: tx.Name(),
			Segments: len(part.Segments),
		})
		key := pipeline.Key{Stage: pipeline.StageTranscribed, Variant: lang}
		if err := uc.Registry.SetStage(ctx, id, key, pipeline.StatusDone, body, ""); err != nil {
			return Result{}, err
		}
	}

	res = Result{
		TrackId:   id,
		Language:  language,
		Provider:  tx.Name(),
		Segments:  len(groups[language]),
		Empty:     len(groups[language]) == 0,
		Languages: langs,
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
