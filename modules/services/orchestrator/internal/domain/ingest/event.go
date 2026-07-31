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
// consumer's decoder: ID is a stable idempotency key, DocID is the library
// membership id (the jobID) — the SAME across every lifecycle state of one
// ingest so the projection advances in place — TrackID carries the content hash
// once known, and Data is the server-owned library_items projection applied
// verbatim.
type TrackEvent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	// RequestID is the originating chat turn's trace_id, carried onto the
	// lifecycle stream so downstream consumers (profile, chat, storage-sync)
	// stay on the same correlation chain as the pipeline that produced them.
	RequestID string `json:"request_id,omitempty"`
	UserID    string `json:"user_id"`
	DocID     string `json:"doc_id"`
	// Generation is the job's re-run counter (0 for the original run), carried so
	// the profile projection can stamp a retry's lifecycle above the prior run's
	// terminal state. Omitted for a generation-0 event, decoding back to 0.
	Generation int             `json:"generation,omitempty"`
	TrackID    string          `json:"track_id,omitempty"`
	Data       json.RawMessage `json:"data,omitempty"`
}

// Marshal serializes the event for the outbox payload column.
func (e TrackEvent) Marshal() ([]byte, error) { return json.Marshal(e) }
