// Package gemini submits review chunks to the Gemini batch endpoint, which
// bills at half the synchronous rate in exchange for a completion window of up
// to 24 hours.
//
// The API is two-phase — submit returns a job name, results arrive later — so
// this package deliberately does not implement review.Reviewer: that port
// promises a corrected chunk on return. Callers submit, persist the job name,
// and fetch when the job finishes.
package gemini

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const defaultEndpoint = "https://generativelanguage.googleapis.com/v1beta"

type Client struct {
	Endpoint string
	APIKey   string
	Model    string // e.g. "models/gemini-flash-lite-latest"
	HTTP     *http.Client
}

type Options struct {
	Endpoint string
	APIKey   string
	Model    string
	Timeout  time.Duration
}

func New(opts Options) (*Client, error) {
	if strings.TrimSpace(opts.APIKey) == "" {
		return nil, fmt.Errorf("gemini batch: api key is empty")
	}
	if strings.TrimSpace(opts.Model) == "" {
		return nil, fmt.Errorf("gemini batch: model is empty")
	}
	endpoint := strings.TrimRight(opts.Endpoint, "/")
	if endpoint == "" {
		endpoint = defaultEndpoint
	}
	model := opts.Model
	if !strings.HasPrefix(model, "models/") {
		model = "models/" + model
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 5 * time.Minute
	}
	return &Client{
		Endpoint: endpoint,
		APIKey:   opts.APIKey,
		Model:    model,
		HTTP:     &http.Client{Timeout: timeout},
	}, nil
}

// Request is one chunk to review. Key addresses the reply: it comes back
// verbatim, so the caller reassembles by key rather than by position.
type Request struct {
	Key         string
	System      string
	User        string
	Temperature float64
	MaxTokens   int
}

// State mirrors the job states the API reports.
type State string

const (
	StatePending   State = "BATCH_STATE_PENDING"
	StateRunning   State = "BATCH_STATE_RUNNING"
	StateSucceeded State = "BATCH_STATE_SUCCEEDED"
	StateFailed    State = "BATCH_STATE_FAILED"
	StateCancelled State = "BATCH_STATE_CANCELLED"
)

// Done reports whether the job has stopped moving. It says nothing about
// whether the requests inside it worked: a job reports SUCCEEDED with every
// request failed. Read Stats for that.
func (s State) Done() bool {
	return s != "" && s != StatePending && s != StateRunning
}

type Stats struct {
	Total      int
	Pending    int
	Successful int
	Failed     int
}

type Job struct {
	Name  string
	State State
	Stats Stats
}

// Result is one reply. Exactly one of Text or Err is meaningful.
type Result struct {
	Key       string
	Text      string
	Err       error
	TokensIn  int64
	TokensOut int64
}

func (c *Client) do(ctx context.Context, method, url string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("X-goog-api-key", c.APIKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return fmt.Errorf("gemini batch: %s %s: %s", method, resp.Status, truncate(raw, 300))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// Submit queues the requests and returns the job name to poll.
func (c *Client) Submit(ctx context.Context, displayName string, reqs []Request) (string, error) {
	if len(reqs) == 0 {
		return "", fmt.Errorf("gemini batch: no requests")
	}
	seen := make(map[string]struct{}, len(reqs))
	items := make([]wireItem, 0, len(reqs))
	for _, r := range reqs {
		if r.Key == "" {
			return "", fmt.Errorf("gemini batch: request without a key")
		}
		if _, dup := seen[r.Key]; dup {
			return "", fmt.Errorf("gemini batch: duplicate key %q", r.Key)
		}
		seen[r.Key] = struct{}{}
		items = append(items, buildItem(r))
	}
	body := map[string]any{"batch": map[string]any{
		"displayName": displayName,
		"inputConfig": map[string]any{"requests": map[string]any{"requests": items}},
	}}
	var out struct {
		Name string `json:"name"`
	}
	url := fmt.Sprintf("%s/%s:batchGenerateContent", c.Endpoint, c.Model)
	if err := c.do(ctx, http.MethodPost, url, body, &out); err != nil {
		return "", err
	}
	if out.Name == "" {
		return "", fmt.Errorf("gemini batch: submit returned no job name")
	}
	return out.Name, nil
}

// Status reports where the job is. Name is what Submit returned.
func (c *Client) Status(ctx context.Context, name string) (Job, error) {
	var out wireJob
	if err := c.do(ctx, http.MethodGet, c.jobURL(name), nil, &out); err != nil {
		return Job{}, err
	}
	return out.job(name), nil
}

// Fetch returns the replies once the job is done. Requests that failed come
// back with Err set, so a caller can re-run just those synchronously instead
// of waiting on another batch window.
func (c *Client) Fetch(ctx context.Context, name string) (Job, []Result, error) {
	var out wireJob
	if err := c.do(ctx, http.MethodGet, c.jobURL(name), nil, &out); err != nil {
		return Job{}, nil, err
	}
	job := out.job(name)
	if !job.State.Done() {
		return job, nil, fmt.Errorf("gemini batch: job %s is %s, results are not ready", name, job.State)
	}
	inlined := out.Response.InlinedResponses.InlinedResponses
	if len(inlined) == 0 {
		inlined = out.Metadata.Output.InlinedResponses.InlinedResponses
	}
	results := make([]Result, 0, len(inlined))
	for _, item := range inlined {
		res := Result{Key: item.Metadata.Key}
		if item.Error != nil && item.Error.Message != "" {
			res.Err = fmt.Errorf("gemini batch: request %s failed: %s", res.Key, item.Error.Message)
			results = append(results, res)
			continue
		}
		res.TokensIn = item.Response.UsageMetadata.PromptTokenCount
		res.TokensOut = item.Response.UsageMetadata.CandidatesTokenCount
		res.Text = item.Response.text()
		if res.Text == "" {
			res.Err = fmt.Errorf("gemini batch: request %s returned no text", res.Key)
		}
		results = append(results, res)
	}
	return job, results, nil
}

// Missing returns the keys that were submitted but absent from the replies,
// which is how a dropped request surfaces: the job reports success and simply
// says nothing about it.
func Missing(submitted []Request, got []Result) []string {
	have := make(map[string]struct{}, len(got))
	for _, r := range got {
		have[r.Key] = struct{}{}
	}
	var out []string
	for _, r := range submitted {
		if _, ok := have[r.Key]; !ok {
			out = append(out, r.Key)
		}
	}
	return out
}

func (c *Client) jobURL(name string) string {
	return fmt.Sprintf("%s/%s", c.Endpoint, strings.TrimPrefix(name, "/"))
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
