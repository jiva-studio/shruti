// Package openaicompatembed turns text into dense vectors via an
// OpenAI-compatible /embeddings endpoint — the same call the chat indexer and
// search-mcp make, so all vectors share one space. Unlike search-mcp (which
// embeds one query at a time), this has a batch path: the topic build embeds
// hundreds of thousands of outline headings.
package openaicompatembed

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"sort"
	"time"
)

type Config struct {
	Endpoint string
	APIKey   string
	Model    string
	// Dimensions, when > 0, asks the endpoint to return shorter vectors
	// (text-embedding-3-* support this). 256 is plenty for clustering headings
	// and keeps ~350k vectors well within memory.
	Dimensions int
	// BatchSize caps how many inputs go in one HTTP call (0 → 96).
	BatchSize int
	// Timeout bounds a single HTTP call including the body read (0 → 120s). A
	// timeout here is transient and retried, not fatal.
	Timeout time.Duration
}

type Client struct {
	http       *http.Client
	endpoint   string
	apiKey     string
	model      string
	dimensions int
	batchSize  int
}

func New(cfg Config) (*Client, error) {
	if cfg.Model == "" {
		return nil, fmt.Errorf("embeddings client: model is empty")
	}
	endpoint := cfg.Endpoint
	if endpoint == "" {
		endpoint = "https://openrouter.ai/api/v1"
	}
	batch := cfg.BatchSize
	if batch <= 0 {
		batch = 96
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	return &Client{
		http:       &http.Client{Timeout: timeout},
		endpoint:   endpoint,
		apiKey:     cfg.APIKey,
		model:      cfg.Model,
		dimensions: cfg.Dimensions,
		batchSize:  batch,
	}, nil
}

// Dim returns the configured embedding dimensionality (0 = provider default).
func (c *Client) Dim() int { return c.dimensions }

// Model returns the configured embedding model id — the space all vectors
// belong to. Recorded in the vocabulary so assign can detect a config drift.
func (c *Client) Model() string { return c.model }

// Embed returns one vector per input text, in the same order. Inputs are sent
// in batches; a failed batch is retried a few times on 429/5xx before failing
// the whole call.
func (c *Client) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += c.batchSize {
		end := start + c.batchSize
		if end > len(texts) {
			end = len(texts)
		}
		vecs, err := c.embedBatch(ctx, texts[start:end])
		if err != nil {
			return nil, fmt.Errorf("embed batch [%d:%d]: %w", start, end, err)
		}
		out = append(out, vecs...)
	}
	return out, nil
}

type embedRequest struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type embedResponse struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

func (c *Client) embedBatch(ctx context.Context, batch []string) ([][]float32, error) {
	body, err := json.Marshal(embedRequest{Model: c.model, Input: batch, Dimensions: c.dimensions})
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	const maxAttempts = 5
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			// Exponential backoff: 1s, 2s, 4s, 8s. Honors ctx cancellation.
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(1<<(attempt-1)) * time.Second):
			}
		}
		vecs, retryable, err := c.doBatch(ctx, body, len(batch))
		if err == nil {
			return vecs, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}
	return nil, fmt.Errorf("after %d attempts: %w", maxAttempts, lastErr)
}

// isTimeout reports whether err is a deadline/timeout (the http.Client.Timeout
// firing, a context deadline, or a net.Error timeout) rather than a permanent
// failure — such errors are worth retrying.
func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// doBatch performs one HTTP call. retryable is true for 429/5xx so the caller
// backs off; client errors (4xx other than 429) are terminal.
func (c *Client) doBatch(ctx context.Context, body []byte, n int) (vecs [][]float32, retryable bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("request failed: %w", err) // network → retry
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		retry := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return nil, retry, fmt.Errorf("endpoint %d: %s", resp.StatusCode, buf.String())
	}
	var out embedResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		// A timeout while reading the body (the client Timeout firing, or a
		// slow/stalled endpoint) is transient, not corruption — retry it. Only
		// when the parent ctx is still live: a genuine run cancellation must
		// abort, not loop. Anything else (real JSON garbage) stays terminal.
		retryable := ctx.Err() == nil && isTimeout(err)
		return nil, retryable, fmt.Errorf("decode response: %w", err)
	}
	if len(out.Data) != n {
		return nil, false, fmt.Errorf("expected %d vectors, got %d", n, len(out.Data))
	}
	// Order is usually request-order, but the API only guarantees the `index`
	// field — sort by it to be safe.
	sort.Slice(out.Data, func(i, j int) bool { return out.Data[i].Index < out.Data[j].Index })
	vecs = make([][]float32, len(out.Data))
	for i, d := range out.Data {
		if len(d.Embedding) == 0 {
			return nil, false, fmt.Errorf("empty vector at index %d", d.Index)
		}
		// Reject NaN/Inf: a non-finite component poisons every downstream
		// cosine (normalize, nearest), and a single NaN makes nearest return
		// no match — silently wrong clusters/assignments, or a panic. Treat
		// it as terminal corruption rather than retrying deterministic garbage.
		for _, x := range d.Embedding {
			if math.IsNaN(float64(x)) || math.IsInf(float64(x), 0) {
				return nil, false, fmt.Errorf("non-finite value in vector at index %d", d.Index)
			}
		}
		vecs[i] = d.Embedding
	}
	return vecs, false, nil
}
