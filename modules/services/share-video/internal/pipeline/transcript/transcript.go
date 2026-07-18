// Package transcript provides the audio-to-words interface and a single
// backend: an OpenAI-compatible /audio/transcriptions client. It defaults
// to OpenRouter (openrouter.ai/api/v1) but the base URL is configurable,
// so it also talks to native OpenAI or any compatible upstream unchanged.
//
// The pipeline never knows which upstream ran — it only sees Result.
package transcript

import (
	"context"
	"fmt"
	"strings"
)

type Word struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type Result struct {
	Text  string `json:"text"`
	Words []Word `json:"words"`
}

type Options struct {
	Language string
}

type Transcriber interface {
	Transcribe(ctx context.Context, audioPath string, opts Options) (Result, error)
}

// Config wires the OpenAI-compatible transcription client.
type Config struct {
	APIKey  string // OPENROUTER_API_KEY (or an OpenAI key when BaseURL points at OpenAI)
	BaseURL string // e.g. https://openrouter.ai/api/v1
	Model   string // e.g. openai/whisper-large-v3
}

// New builds the transcriber. A missing API key is a fatal misconfig — we
// fail at boot rather than at the first render.
func New(c Config) (Transcriber, error) {
	if strings.TrimSpace(c.APIKey) == "" {
		return nil, fmt.Errorf("transcriber requires an API key (OPENROUTER_API_KEY)")
	}
	return newClient(c), nil
}
