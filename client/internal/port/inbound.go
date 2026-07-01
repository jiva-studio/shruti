package port

import (
	"context"

	"github.com/jiva-studio/shruti/client/internal/domain"
)

// StartRequest is the UI's request to begin a meeting. Sources is the resolved
// list of capture endpoints (1..N); the application assigns channel indices.
type StartRequest struct {
	Provider  domain.ProviderID
	Languages []domain.Language
	Sources   []domain.Source
}

// RecordingService is the driving (inbound) port: the single entry point the UI
// adapter calls to run a meeting. Implemented by internal/app.
type RecordingService interface {
	// Devices lists selectable capture endpoints for the UI.
	Devices(ctx context.Context) ([]domain.Device, error)
	// Start begins capture + live transcription, invoking the emit callback for
	// every event (partial and final) so the UI can render live subtitles.
	Start(ctx context.Context, req StartRequest, emit func(domain.TranscriptEvent)) error
	// Stop ends the meeting, persists it, summarizes it, and returns the summary.
	Stop(ctx context.Context) (domain.Summary, error)
}
