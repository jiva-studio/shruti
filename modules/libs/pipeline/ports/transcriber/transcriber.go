// Package transcriber is the audio→text port for the transcribe stage.
//
// Multiple providers can be registered behind a single MCP tool (whisper.cpp
// today; OpenAI Whisper API and others can be plugged in without changes to
// the application layer). Each implementation is responsible for normalizing
// its provider output into a transcript.Raw whose segments have:
//   - Idx       sequential 0..N
//   - Start/End offsets into the audio in milliseconds
//   - Text      trimmed UTF-8, no leading whitespace
package transcriber

import (
	"context"

	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

type Options struct {
	Language string // ISO code; empty = auto-detect
	Model    string // override default model path/identifier; empty = provider default
}

type Transcriber interface {
	Name() string
	Transcribe(ctx context.Context, audioPath string, opts Options) (transcript.Raw, error)
}

// Registry mirrors review.Registry: many concrete transcribers register at
// startup, callers pick one by name (or fall back to the default).
type Registry interface {
	Register(t Transcriber)
	SetDefault(name string)
	Get(name string) (Transcriber, bool)
	Default() Transcriber
	List() []string
}
