package ingest

import "encoding/json"

// Track lifecycle event types published on the `track.events` stream. Consumers
// (profile projects into library_items, chat indexes the transcript for RAG)
// key on Type. Stable strings — they are part of the broker contract.
const (
	EventQueued     = "track.queued"
	EventProcessing = "track.processing"
	EventReady      = "track.ready"
	EventFailed     = "track.failed"
)

// TrackEvent is one `track.events` message. The shape matches the profile
// consumer's decoder: ID is a stable idempotency key (the source message id),
// DocID is the track id (the content hash) once known — else the job id — and
// Data is the server-owned library_items projection applied verbatim.
type TrackEvent struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	UserID  string          `json:"user_id"`
	DocID   string          `json:"doc_id"`
	TrackID string          `json:"track_id,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Marshal serializes the event for the outbox payload column.
func (e TrackEvent) Marshal() ([]byte, error) { return json.Marshal(e) }
