// Package transcript provides the audio-to-words interface and the two
// concrete backends share-video supports: OpenAI Whisper and Yandex
// SpeechKit v3 (async file recognition).
//
// Selection happens at boot via TRANSCRIBER env (whisper | speechkit).
// The pipeline never knows which backend ran.
package transcript

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
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

// Deps lets the dispatch construct backend-specific clients without
// hauling AWS / S3 wiring into individual transcriber files.
type Deps struct {
	S3                *s3.Client
	S3Presigner       *s3.PresignClient
	Bucket            string
	ScratchPrefix     string
	StorageEndpoint   string // for SpeechKit's external fetch URL — falls back to virtual-hosted
	OpenAIKey         string
	SpeechKitKey      string
}

// New chooses a backend by name. Unknown names error rather than silently
// defaulting — we want misconfigurations to fail fast at boot.
func New(provider string, d Deps) (Transcriber, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "", "whisper":
		if d.OpenAIKey == "" {
			return nil, fmt.Errorf("transcriber=whisper requires OPENAI_API_KEY")
		}
		return newWhisper(d.OpenAIKey), nil
	case "speechkit":
		if d.SpeechKitKey == "" {
			return nil, fmt.Errorf("transcriber=speechkit requires SPEECHKIT_API_KEY")
		}
		return newSpeechKit(d), nil
	default:
		return nil, fmt.Errorf("unknown TRANSCRIBER=%q (expected whisper | speechkit)", provider)
	}
}
