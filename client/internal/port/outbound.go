// Package port declares the interfaces (ports) through which the application
// core talks to the outside world. Adapters under internal/adapter implement
// the driven (outbound) ports; the driving (inbound) port is implemented by the
// application and called by the UI.
package port

import (
	"context"
	"time"

	"github.com/jiva-studio/shruti/client/internal/domain"
)

// AudioSource enumerates capture endpoints and starts a live capture.
type AudioSource interface {
	// Devices lists the selectable sinks, sources and app streams for the UI.
	Devices(ctx context.Context) ([]domain.Device, error)
	// Capture starts one subprocess per plan source and streams PCM frames.
	Capture(ctx context.Context, plan domain.CapturePlan) (Capture, error)
}

// Capture is a running multi-channel capture. Frames for source channel i are
// delivered on Frames(i); every channel is closed when Stop is called.
type Capture interface {
	Frames(channel int) <-chan []byte
	Sources() []domain.Source
	Stop()
}

// Transcriber opens a live transcription stream for a capture plan. Layout tells
// the application how to pack the plan's channels for this engine.
type Transcriber interface {
	// Layout reports how this engine consumes audio (mixed mono vs multichannel).
	Layout() domain.AudioLayout
	// Open dials the engine and returns a live stream for the plan.
	Open(ctx context.Context, plan domain.CapturePlan) (TranscriptionStream, error)
}

// TranscriptionStream is a single live transcription session.
type TranscriptionStream interface {
	// Write sends one packed audio frame (mono mix, or interleaved N-channel per
	// the engine's Layout) to the engine.
	Write(frame []byte) error
	// Events delivers transcription events (partials and finals) as they arrive.
	// The channel is closed when the session ends.
	Events() <-chan domain.TranscriptEvent
	// Close ends the session, flushing final events, and releases resources.
	Close() error
}

// TranscriberFactory resolves a registered engine by id. Implemented by the
// transcriber registry, so the application never imports concrete engines.
type TranscriberFactory interface {
	Transcriber(id domain.ProviderID) (Transcriber, error)
}

// Summarizer turns a finished meeting into a written summary.
type Summarizer interface {
	Summarize(ctx context.Context, m *domain.Meeting) (domain.Summary, error)
}

// MeetingRepository persists and retrieves meetings.
type MeetingRepository interface {
	Save(ctx context.Context, m *domain.Meeting) error
	Get(ctx context.Context, id domain.MeetingID) (*domain.Meeting, error)
	List(ctx context.Context) ([]domain.Meeting, error)
}

// Clock is the application's source of time (injected for testability).
type Clock interface {
	Now() time.Time
}
