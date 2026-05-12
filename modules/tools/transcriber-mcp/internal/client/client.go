package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ErrNotFound is returned by GetJob/GetTranscript/DeleteJob when the service
// responds with HTTP 404. Callers can compare with errors.Is(err, ErrNotFound).
var ErrNotFound = errors.New("transcriber-service: not found")

// ErrConflict is returned for HTTP 409 (e.g. transcript not yet ready).
var ErrConflict = errors.New("transcriber-service: conflict")

// Client talks to a transcriber-service over HTTP.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New constructs a client with a sane default HTTP timeout. Per-call timeouts
// are controlled via context.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

// GetHealth fetches /healthz.
func (c *Client) GetHealth(ctx context.Context) (*Health, error) {
	var h Health
	if err := c.getJSON(ctx, "/healthz", &h); err != nil {
		return nil, err
	}
	return &h, nil
}

// GetJob fetches one job's metadata. Returns ErrNotFound if the job is unknown.
func (c *Client) GetJob(ctx context.Context, jobID string) (*Job, error) {
	var j Job
	if err := c.getJSON(ctx, "/jobs/"+url.PathEscape(jobID), &j); err != nil {
		return nil, err
	}
	return &j, nil
}

// ListJobs returns recent jobs, optionally filtered by status.
func (c *Client) ListJobs(ctx context.Context, status string, limit int) ([]*Job, error) {
	q := url.Values{}
	if status != "" {
		q.Set("status", status)
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	path := "/jobs"
	if e := q.Encode(); e != "" {
		path += "?" + e
	}
	var jobs []*Job
	if err := c.getJSON(ctx, path, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

// GetTranscript fetches the full transcript JSON. Returns ErrConflict if the
// job is not yet done, ErrNotFound if it doesn't exist.
func (c *Client) GetTranscript(ctx context.Context, jobID string) (*Transcript, error) {
	var t Transcript
	if err := c.getJSON(ctx, "/jobs/"+url.PathEscape(jobID)+"/transcript", &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// DeleteJob removes the job and its transcript. Returns ErrNotFound or
// ErrConflict (running) on the corresponding HTTP statuses.
func (c *Client) DeleteJob(ctx context.Context, jobID string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.BaseURL+"/jobs/"+url.PathEscape(jobID), nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent:
		return nil
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusConflict:
		return ErrConflict
	default:
		return c.unexpectedStatus(resp)
	}
}

// --- internals ---

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
