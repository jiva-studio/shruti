// Package deepgram adapts the shared pipeline Deepgram transcriber to the
// worker's ports.Transcriber, which reports the detected language separately.
package deepgram

import (
	"context"

	"github.com/jiva-studio/lectorium/pipeline/ports/transcriber"
	dg "github.com/jiva-studio/lectorium/pipeline/transcriber/deepgram"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

type Transcriber struct{ inner *dg.Transcriber }

func New(apiKey, model string) *Transcriber {
	return &Transcriber{inner: dg.New(dg.Config{APIKey: apiKey, Model: model})}
}

func (t *Transcriber) Transcribe(ctx context.Context, audioPath string) (transcript.Raw, string, error) {
	raw, err := t.inner.Transcribe(ctx, audioPath, transcriber.Options{})
	if err != nil {
		return transcript.Raw{}, "", err
	}
	return raw, raw.Language, nil
}
