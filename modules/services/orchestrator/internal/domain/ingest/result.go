package ingest

import "encoding/json"

// Ingest result phases the worker reports on the `ingest.result` stream. The
// orchestrator maps them onto job-state transitions and `track.events`.
const (
	// PhaseProcessing is a best-effort heartbeat — moves queued → running.
	PhaseProcessing = "processing"
	// PhaseReady is the terminal success: audio + transcript were stored.
	PhaseReady = "ready"
	// PhaseLinked is the terminal dedup success (identical audio already stored).
	PhaseLinked = "linked"
	// PhaseFailed is the terminal failure; Retriable drives the retry decision.
	PhaseFailed = "failed"
)

// Result is one decoded `ingest.result` message from the worker. JobID
// correlates it back to the orchestrator's job (results are keyed on job_id,
// NOT the broker message id). Artifact fields are set on ready/linked;
// Error/Retriable on failed.
type Result struct {
	JobID         string `json:"job_id"`
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

// DecodeResult parses a broker payload into a Result.
func DecodeResult(b []byte) (Result, error) {
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return Result{}, err
	}
	return r, nil
}
