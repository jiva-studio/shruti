package main

import (
	"fmt"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	transcribereg "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/transcribe"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/transcribe/transcriberservice"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/worker"
	"github.com/jiva-studio/lectorium/pipeline/transcriber/deepgram"
)

// The registry mirrors the review/resolver pattern so adding (e.g.) an OpenAI
// Whisper adapter later only adds a Kind branch here, not new wiring through
// the application layer.
func buildTranscribeRegistry(cfg config.Transcribe, concurrency int) (*transcribereg.Registry, error) {
	reg := transcribereg.New()
	for name, p := range cfg.Providers {
		switch p.Kind {
		case "transcriber-service":
			t := transcriberservice.New(transcriberservice.Config{
				Endpoint: p.Endpoint,
				Cleanup:  true,
			})
			reg.Register(worker.NewThrottledTranscriber(t, concurrency))
		case "deepgram":
			if p.APIKey == "" {
				return nil, fmt.Errorf("transcribe provider %q: deepgram needs api_key", name)
			}
			t := deepgram.New(deepgram.Config{
				APIKey:   p.APIKey,
				Model:    p.Model,
				Language: p.Language,
				Diarize:  p.Diarize,
			})
			reg.Register(worker.NewThrottledTranscriber(t, concurrency))
		default:
			return nil, fmt.Errorf("transcribe provider %q: unknown kind %q", name, p.Kind)
		}
	}
	reg.SetDefault(cfg.Default)
	return reg, nil
}
