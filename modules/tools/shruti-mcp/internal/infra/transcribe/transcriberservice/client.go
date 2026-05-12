// Package transcriberservice is the transcribe.Transcriber adapter that
// proxies the work to the sibling transcriber-service over HTTP. The
// HTTP client below mirrors transcriber-mcp/internal/client (DTOs +
// GetJob/GetTranscript/DeleteJob/GetHealth) and adds the upload endpoint
// the read-only sibling didn't need.
package transcriberservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotFound mirrors transcriber-service 404 responses.
var ErrNotFound = errors.New("transcriber-service: not found")

// ErrConflict mirrors transcriber-service 409 (e.g. transcript not ready).
var ErrConflict = errors.New("transcriber-service: conflict")

// Status is the lifecycle state of a transcription job.
type Status string

const (
	StatusQueued  Status = "queued"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// Job is the metadata record returned by the service for one job.
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

// WordTiming is one word of a Parakeet transcript.
type WordTiming struct {
	Word       string  `json:"word"`
	StartTime  float64 `json:"startTime"`
	EndTime    float64 `json:"endTime"`
	Confidence float64 `json:"confidence"`
}

// Transcript mirrors the JSON the service returns from
// GET /jobs/{id}/transcript.
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

// uploadResp is the POST /jobs response shape (only the fields we use).
type uploadResp struct {
	JobID    string `json:"job_id"`
	Status   Status `json:"status"`
	Filename string `json:"filename"`
}

// Client talks to a transcriber-service over HTTP.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// newClient constructs a *Client. Unexported because the package's
// public entry point is the Transcriber adapter (see transcriber.go);
// the Client itself is an internal collaborator.
func newClient(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		// No global timeout — uploads of multi-hundred-MB lectures must
		// not be cut off by an arbitrary clock. Per-call deadlines come
		// from ctx.
		HTTP: &http.Client{},
	}
}

// Upload posts the audio file to POST /jobs and returns the assigned
// job_id. `language` is optional (empty = service default / auto-detect).
func (c *Client) Upload(ctx context.Context, audioPath, language string) (string, error) {
	f, err := os.Open(audioPath)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", audioPath, err)
	}
	defer f.Close()

	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	// Write the multipart body in a goroutine so the request body can
	// stream straight from disk without buffering the entire file.
	go func() {
		defer pw.Close()
		defer mw.Close()
		if language != "" {
			if err := mw.WriteField("language", language); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
		}
		fw, err := mw.CreateFormFile("file", filepath.Base(audioPath))
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		if _, err := io.Copy(fw, f); err != nil {
			_ = pw.CloseWithError(err)
			return
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/jobs", pr)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return "", c.unexpectedStatus(resp)
	}
	var out uploadResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode upload response: %w", err)
	}
	if out.JobID == "" {
		return "", fmt.Errorf("upload: empty job_id in response")
	}
	return out.JobID, nil
}

// GetJob fetches one job's metadata.
func (c *Client) GetJob(ctx context.Context, jobID string) (*Job, error) {
	var j Job
	if err := c.getJSON(ctx, "/jobs/"+url.PathEscape(jobID), &j); err != nil {
		return nil, err
	}
	return &j, nil
}

// GetTranscript fetches the transcript JSON. ErrConflict if not done yet.
func (c *Client) GetTranscript(ctx context.Context, jobID string) (*Transcript, error) {
	var t Transcript
	if err := c.getJSON(ctx, "/jobs/"+url.PathEscape(jobID)+"/transcript", &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// DeleteJob is a best-effort cleanup. We never want a delete failure to
// wash out a successful transcription, so callers usually ignore the
// returned error.
func (c *Client) DeleteJob(ctx context.Context, jobID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.BaseURL+"/jobs/"+url.PathEscape(jobID), nil)
	if err != nil {
		return err
	}
	// Short timeout — this is best-effort cleanup, not a critical step.
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req = req.WithContext(dctx)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent, http.StatusNotFound:
		return nil
	case http.StatusConflict:
		return ErrConflict
	default:
		return c.unexpectedStatus(resp)
	}
}

func (c *Client) getJSON(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return json.NewDecoder(resp.Body).Decode(into)
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusConflict:
		return ErrConflict
	default:
		return c.unexpectedStatus(resp)
	}
}

func (c *Client) unexpectedStatus(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	msg := strings.TrimSpace(string(body))
	if msg == "" {
		msg = resp.Status
	}
	return fmt.Errorf("transcriber-service: HTTP %d: %s", resp.StatusCode, msg)
}
