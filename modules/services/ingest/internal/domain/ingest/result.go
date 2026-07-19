package ingest

import "encoding/json"

// Ingest result phases published on the `ingest.result` stream. The worker
// emits exactly one TERMINAL result (ready | linked | failed) per work item,
// preceded by a best-effort non-terminal "processing" heartbeat.
const (
	// PhaseProcessing is a best-effort heartbeat emitted before the fetch —
	// it moves the orchestrator's job from queued to running.
	PhaseProcessing = "processing"
	// PhaseReady is the terminal success: audio + transcript were stored.
	PhaseReady = "ready"
	// PhaseLinked is the terminal dedup success: identical audio was already
	// stored by a prior job, so this owner is linked to it without re-work.
	PhaseLinked = "linked"
	// PhaseFailed is the terminal failure. Retriable distinguishes transient
	// faults (the orchestrator may re-dispatch) from permanent ones.
	PhaseFailed = "failed"
)

// Result is one `ingest.result` message: the worker's report on a work item.
// JobID echoes the WorkCommand so the orchestrator loads the right job. The
// artifact fields are populated on ready/linked; Error/Retriable on failed.
type Result struct {
	JobID string `json:"job_id"`
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
	Error         string `json:"error,omitempty"`
	Retriable     bool   `json:"retriable,omitempty"`
}

// Marshal serializes the result for the `ingest.result` payload field.
func (r Result) Marshal() ([]byte, error) { return json.Marshal(r) }

// DecodeResult parses a broker payload into a Result.
func DecodeResult(b []byte) (Result, error) {
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return Result{}, err
	}
	return r, nil
}
