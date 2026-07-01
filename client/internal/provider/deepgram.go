package provider

import (
	"context"
	"errors"
)

// ErrNotImplemented is returned by provider stubs that satisfy the interface
// but are not yet wired up.
var ErrNotImplemented = errors.New("provider: not implemented")

// deepgram is a stub Transcriber that keeps the cloud extension point real
// (registered in the factory) without a working implementation yet.
type deepgram struct{}

// NewDeepgram returns the (stub) Deepgram Transcriber.
func NewDeepgram(SessionConfig) Transcriber { return deepgram{} }

func (deepgram) Open(context.Context, SessionConfig) (Session, error) {
	return nil, errors.New("deepgram provider is not implemented: " + ErrNotImplemented.Error())
}
