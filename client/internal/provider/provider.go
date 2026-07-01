// Package provider defines the transcription-provider extension point for
// Shruti and its implementations. A Transcriber opens a streaming Session per
// channel; the client writes live PCM and reads v1.Update messages back.
//
// The default provider is "parakeet" (the Mac host via streamd over WebSocket).
// "deepgram" is a drop-in cloud alternative kept as a real, registered
// extension point (currently a stub).
package provider

import (
	"context"

	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// SessionConfig configures a single streaming transcription session.
type SessionConfig struct {
	// URL is the provider endpoint. For parakeet this is the streamd
	// WebSocket base, e.g. ws://127.0.0.1:18005/v1/stream (the tailnet
	// forwarder to mridanga:8082).
	URL string
	// Channel is v1.ChannelSystem or v1.ChannelMic.
	Channel string
	// Lang is an optional ASR language hint (e.g. "ru").
	Lang string
}

// Transcriber opens streaming transcription sessions.
type Transcriber interface {
	// Open dials the provider and returns a live Session for cfg.Channel.
	Open(ctx context.Context, cfg SessionConfig) (Session, error)
}

// Session is a single live transcription stream for one channel.
type Session interface {
	// Write sends a chunk of raw s16le/16k/mono PCM to the provider.
	Write(pcm []byte) error
	// Updates delivers transcription updates (partials and finals) as they
	// arrive. The channel is closed when the session ends.
	Updates() <-chan v1.Update
	// Close ends the session, flushing a final and releasing resources.
	Close() error
}
