// Package client is a typed HTTP client for transcriber-service. The DTOs are
// duplicated from transcriber-service/internal/job to keep this package
// independently versioned — the service is free to add fields and we'll see
// them as ignored extras until we explicitly opt into them here.
package client

// Status is the lifecycle state of a transcription job.
type Status string

const (
	StatusQueued  Status = "queued"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// Job is the metadata record returned by the service for one transcription job.
type Job struct {
	JobID                 string  `json:"job_id"`
	Filename              string  `json:"filename"`
	Language              string  `json:"language,omitempty"`
	Status                Status  `json:"status"`
	UploadedAt            int64   `json:"uploaded_at"`
	StartedAt             int64   `json:"started_at,omitempty"`
	CompletedAt           int64   `json:"completed_at,omitempty"`
	DurationSeconds       float64 `json:"duration_seconds,omitempty"`
	ProcessingTimeSeconds float64 `json:"processing_time_seconds,omitempty"`
	RTFx                  float64 `json:"rtfx,omitempty"`
	Confidence            float64 `json:"confidence,omitempty"`
	Error                 string  `json:"error,omitempty"`
}

// Health is the response of GET /healthz.
type Health struct {
	Workers     int   `json:"workers"`
	Queued      int   `json:"queued"`
	Running     int   `json:"running"`
	Done        int   `json:"done"`
	Failed      int   `json:"failed"`
	ModelLoaded bool  `json:"model_loaded"`
	UptimeS     int64 `json:"uptime_s"`
}

// WordTiming is a per-word entry inside a transcript.
type WordTiming struct {
	Word       string  `json:"word"`
	StartTime  float64 `json:"startTime"`
	EndTime    float64 `json:"endTime"`
	Confidence float64 `json:"confidence"`
}

// Transcript mirrors the JSON written by fluidbatchd for one job.
type Transcript struct {
	AudioFile             string       `json:"audioFile"`
	Mode                  string       `json:"mode"`
	ModelVersion          string       `json:"modelVersion"`
	Text                  string       `json:"text"`
	DurationSeconds       float64      `json:"durationSeconds,omitempty"`
	ProcessingTimeSeconds float64      `json:"processingTimeSeconds,omitempty"`
	RTFx                  float64      `json:"rtfx,omitempty"`
	Confidence            float64      `json:"confidence,omitempty"`
	WordTimings           []WordTiming `json:"wordTimings"`
}
