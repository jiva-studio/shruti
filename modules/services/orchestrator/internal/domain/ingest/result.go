package ingest

import "encoding/json"

// Ingest result phases the worker reports on the `ingest.result` stream. The
// orchestrator maps them onto job-state transitions and `track.events`.
const (
	// PhaseProcessing is a best-effort heartbeat — moves queued → running.
	PhaseProcessing = "processing"
	// PhaseReady is the terminal success: audio + transcript were stored.
	PhaseReady = "ready"
	// PhaseFailed is the terminal failure; Retriable drives the retry decision.
	PhaseFailed = "failed"
)

// Result is one decoded `ingest.result` message from the worker. JobID
// correlates it back to the orchestrator's job (results are keyed on job_id,
// NOT the broker message id). Artifact fields are set on ready;
// Error/Retriable on failed.
type Result struct {
	JobID string `json:"job_id"`
	// RequestID echoes the WorkCommand's correlation id back, so the
	// orchestrator's result-side logs rejoin the originating chat turn.
	RequestID string `json:"request_id,omitempty"`
	// Attempt echoes the WorkCommand's attempt number so a stale/duplicate
	// `failed` result (already superseded by a re-dispatch) can be discarded —
	// keeping retry accounting idempotent under at-least-once redelivery.
	Attempt int    `json:"attempt,omitempty"`
	Phase   string `json:"phase"`
	// Stage is the pipeline stage on a processing heartbeat (downloading /
	// transcribing / reviewing / storing); empty on terminal results. Recorded on
	// the job for the live status API — poll-only, never projected to the client.
	Stage string `json:"stage,omitempty"`
	// Percent is the download completion (0-100) on a downloading heartbeat, 0
	// elsewhere. Recorded alongside Stage for the live status API — poll-only.
	Percent int    `json:"percent,omitempty"`
	TrackID string `json:"track_id,omitempty"`
	Lang    string `json:"lang,omitempty"`
	Title   string `json:"title,omitempty"`
	// Extracted metadata (best-effort, ready phase) — projected into the
	// library_items row so the card shows author / place / date, not just a title.
	AuthorRaw     string `json:"author_raw,omitempty"`
	LocationRaw   string `json:"location_raw,omitempty"`
	Date          string `json:"date,omitempty"`
	KindTag       string `json:"kind_tag,omitempty"`
	References    []Ref  `json:"references,omitempty"`
	CoverKey      string `json:"cover_key,omitempty"`
	Duration      int64  `json:"duration,omitempty"`
	AudioKey      string `json:"audio_key,omitempty"`
	TranscriptKey string `json:"transcript_key,omitempty"`
	// Variants lists every stored per-language transcript; Lang/TranscriptKey
	// mirror the primary. Projected into library_items.variants for the client's
	// multi-language transcript viewer.
	Variants  []Variant `json:"variants,omitempty"`
	SourceURL string    `json:"source_url,omitempty"`
	Error     string    `json:"error,omitempty"`
	Retriable bool      `json:"retriable,omitempty"`
}

// Variant is one stored per-language transcript: its language, the bucket key of
// transcripts/<lang>.json, and the overview generated from that language. Audio
// is shared, so not repeated here.
type Variant struct {
	Lang          string         `json:"lang"`
	TranscriptKey string         `json:"transcript_key"`
	Description   string         `json:"description,omitempty"`
	Outline       []OutlineEntry `json:"outline,omitempty"`
}

// OutlineEntry is one chapter heading with its [start,end) span in ms, carried
// verbatim from the worker and projected into the library_items row.
type OutlineEntry struct {
	Title string `json:"title"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
}

// Ref is one scripture reference carried from the worker and projected verbatim
// into the library_items row, in the client's domain `Reference` shape.
// SourceName is the raw code (rendered as-is); SourceID is the resolved catalog
// id when a normalize stage ran (empty today). Exactly one is set.
type Ref struct {
	SourceID   string   `json:"sourceId,omitempty"`
	SourceName string   `json:"sourceName,omitempty"`
	Tokens     []string `json:"tokens,omitempty"`
}

// DecodeResult parses a broker payload into a Result.
func DecodeResult(b []byte) (Result, error) {
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		return Result{}, err
	}
	return r, nil
}
