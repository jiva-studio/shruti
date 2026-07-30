package ingest

import "encoding/json"

// Ingest result phases published on the `ingest.result` stream. The worker
// emits exactly one TERMINAL result (ready | failed) per work item, preceded by
// a best-effort non-terminal "processing" heartbeat.
const (
	// PhaseProcessing is a best-effort heartbeat emitted before the fetch —
	// it moves the orchestrator's job from queued to running.
	PhaseProcessing = "processing"
	// PhaseReady is the terminal success: audio + transcript were stored.
	PhaseReady = "ready"
	// PhaseFailed is the terminal failure. Retriable distinguishes transient
	// faults (the orchestrator may re-dispatch) from permanent ones.
	PhaseFailed = "failed"
)

// Result is one `ingest.result` message: the worker's report on a work item.
// JobID echoes the WorkCommand so the orchestrator loads the right job. The
// artifact fields are populated on ready; Error/Retriable on failed.
type Result struct {
	JobID string `json:"job_id"`
	// RequestID echoes the WorkCommand's correlation id so the orchestrator's
	// result-side logs rejoin the originating chat turn.
	RequestID string `json:"request_id,omitempty"`
	// Attempt echoes the WorkCommand's attempt number so the orchestrator can
	// discard a stale/duplicate result whose attempt has already been superseded
	// by a re-dispatch (idempotent retry accounting across redelivery).
	Attempt       int    `json:"attempt,omitempty"`
	Phase         string `json:"phase"`
	TrackID       string `json:"track_id,omitempty"`
	Lang          string `json:"lang,omitempty"`
	Title         string `json:"title,omitempty"`
	AudioKey      string `json:"audio_key,omitempty"`
	TranscriptKey string `json:"transcript_key,omitempty"`
	SourceURL     string `json:"source_url,omitempty"`
	// Extracted metadata (best-effort, ready phase): the raw author/location,
	// the ISO date, the kind tag, and any scripture references parsed from the
	// title. Empty when the extractor is unconfigured or found nothing. The
	// orchestrator projects these into the library_items row.
	AuthorRaw   string `json:"author_raw,omitempty"`
	LocationRaw string `json:"location_raw,omitempty"`
	Date        string `json:"date,omitempty"`
	KindTag     string `json:"kind_tag,omitempty"`
	References  []Ref  `json:"references,omitempty"`
	// CoverKey is the public bucket key of the stored cover image, set when the
	// worker fetched a thumbnail for the source. Empty when none was available.
	CoverKey  string `json:"cover_key,omitempty"`
	Error     string `json:"error,omitempty"`
	Retriable bool   `json:"retriable,omitempty"`
}

// Ref is one scripture reference extracted from the title, in the client's
// domain `Reference` shape so it rides the sync payload straight into the model
// with no wire-type in between. SourceName is the raw code (e.g. "BG"), rendered
// as-is; SourceID is the resolved catalog id, populated only once a normalize
// stage runs (empty today). Exactly one of the two is set.
type Ref struct {
	SourceID   string   `json:"sourceId,omitempty"`
	SourceName string   `json:"sourceName,omitempty"`
	Tokens     []string `json:"tokens,omitempty"`
}

// Marshal serializes the result for the `ingest.result` payload field. The
// worker only produces results; the orchestrator owns the decode side.
func (r Result) Marshal() ([]byte, error) { return json.Marshal(r) }
