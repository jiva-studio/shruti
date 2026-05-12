// Package job defines the persistent Job record and the DTOs returned by the HTTP API.
package job

// Status enumerates the possible lifecycle states of a job.
type Status string

const (
	StatusQueued  Status = "queued"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// Job is the canonical persisted record. Time fields are unix milliseconds.
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

// CreateResponse is returned from POST /jobs.
type CreateResponse struct {
	JobID    string `json:"job_id"`
	Status   Status `json:"status"`
	Filename string `json:"filename"`
}

// HealthResponse is returned from GET /healthz.
type HealthResponse struct {
	Workers     int   `json:"workers"`
	Queued      int   `json:"queued"`
	Running     int   `json:"running"`
	Done        int   `json:"done"`
	Failed      int   `json:"failed"`
	ModelLoaded bool  `json:"model_loaded"`
	UptimeS     int64 `json:"uptime_s"`
}

// Metrics holds the numbers parsed from a fluidbatchd OK event.
type Metrics struct {
	ProcessingTimeSeconds float64
	DurationSeconds       float64
	Confidence            float64
	RTFx                  float64
}
