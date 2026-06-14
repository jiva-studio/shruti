// Package client is a typed HTTP client for denoiser-service. DTOs are
// duplicated from the service to keep this package independently versioned.
package client

// Status is the lifecycle state of a denoise job.
type Status string

const (
	StatusQueued  Status = "queued"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// S3Dest is the upload destination + credentials sent with each job. The MCP
// server holds these (set_s3_config) and injects them per request; the service
// never persists them.
type S3Dest struct {
	Bucket          string `json:"bucket"`
	Key             string `json:"key"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	Region          string `json:"region,omitempty"`
	EndpointURL     string `json:"endpoint_url,omitempty"`
	ACL             string `json:"acl,omitempty"`
	ContentType     string `json:"content_type,omitempty"`
}

// DenoiseParams are the algorithm knobs forwarded to denoise_mp3.py.
type DenoiseParams struct {
	// Strategy: "afftdn" (default), "rnnoise", or "rnnoise-mix".
	Strategy string  `json:"strategy"`
	NR       float64 `json:"nr"`      // afftdn: noise reduction dB
	NF       float64 `json:"nf"`      // afftdn: noise floor dB
	MixMin   float64 `json:"mix_min"` // rnnoise-mix: original ratio in pauses
	MixMax   float64 `json:"mix_max"` // rnnoise-mix: original ratio on voice
}

// CreateJobRequest is the POST /jobs body.
type CreateJobRequest struct {
	SourceURL string        `json:"source_url"`
	Dest      S3Dest        `json:"dest"`
	Filename  string        `json:"filename,omitempty"`
	Params    DenoiseParams `json:"params"`
}

// CreateJobResponse is returned from POST /jobs.
type CreateJobResponse struct {
	JobID    string `json:"job_id"`
	Status   Status `json:"status"`
	Filename string `json:"filename"`
}

// Job is the metadata record for one denoise job.
type Job struct {
	JobID                 string  `json:"job_id"`
	Filename              string  `json:"filename"`
	SourceURL             string  `json:"source_url,omitempty"`
	DestBucket            string  `json:"dest_bucket,omitempty"`
	DestKey               string  `json:"dest_key,omitempty"`
	Status                Status  `json:"status"`
	UploadedAt            int64   `json:"uploaded_at"`
	StartedAt             int64   `json:"started_at,omitempty"`
	CompletedAt           int64   `json:"completed_at,omitempty"`
	DurationSeconds       float64 `json:"duration_seconds,omitempty"`
	ProcessingTimeSeconds float64 `json:"processing_time_seconds,omitempty"`
	RTFx                  float64 `json:"rtfx,omitempty"`
	DestURL               string  `json:"dest_url,omitempty"`
	Error                 string  `json:"error,omitempty"`
}

// S3Source is a bucket+prefix to enumerate for batch fan-out, with read/list
// credentials. The service lists the prefix and presigns each object.
type S3Source struct {
	Bucket          string `json:"bucket"`
	Prefix          string `json:"prefix,omitempty"`
	AccessKeyID     string `json:"access_key_id"`
	SecretAccessKey string `json:"secret_access_key"`
	Region          string `json:"region,omitempty"`
	EndpointURL     string `json:"endpoint_url,omitempty"`
}

// BatchItem is one explicit (source_url -> dest_key) pair.
type BatchItem struct {
	SourceURL string `json:"source_url"`
	DestKey   string `json:"dest_key"`
	Filename  string `json:"filename,omitempty"`
}

// BatchRequest is the POST /jobs/batch body. Provide exactly one of Items
// (explicit) or Source (enumerate).
type BatchRequest struct {
	Dest           S3Dest        `json:"dest"`
	Params         DenoiseParams `json:"params"`
	Items          []BatchItem   `json:"items,omitempty"`
	Source         *S3Source     `json:"source,omitempty"`
	DestPrefix     string        `json:"dest_prefix,omitempty"`
	PresignExpiryS int           `json:"presign_expiry_s,omitempty"`
	Limit          int           `json:"limit,omitempty"`
}

// BatchResponse is returned from POST /jobs/batch.
type BatchResponse struct {
	Count  int      `json:"count"`
	JobIDs []string `json:"job_ids"`
}

// ListObjectsRequest is the POST /source/list body.
type ListObjectsRequest struct {
	Source S3Source `json:"source"`
	Limit  int      `json:"limit,omitempty"`
}

// S3Object is one listed object.
type S3Object struct {
	Key  string `json:"key"`
	Size int64  `json:"size"`
}

// ListObjectsResponse is returned from POST /source/list.
type ListObjectsResponse struct {
	Count   int        `json:"count"`
	Objects []S3Object `json:"objects"`
}

// Health is the response of GET /healthz.
type Health struct {
	Workers       int   `json:"workers"`
	Queued        int   `json:"queued"`
	Running       int   `json:"running"`
	Done          int   `json:"done"`
	Failed        int   `json:"failed"`
	DenoiserReady bool  `json:"denoiser_ready"`
	UptimeS       int64 `json:"uptime_s"`
}
