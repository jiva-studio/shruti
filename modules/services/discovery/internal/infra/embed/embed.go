// Package embed turns text into vectors through an OpenAI-compatible
// /embeddings endpoint.
//
// The model and dimension match the corpus, so a discovered recording and a
// published one live in the same space and can be compared later without
// re-embedding either.
package embed

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
)

// batchSize is how many texts go in one request. Large enough to amortize the
// round trip, small enough that one oversized document cannot blow the
// request limit for everything batched with it.
const batchSize = 96

// maxAttempts and baseBackoff shape the retry: 1s, 2s, 4s, 8s.
const (
	maxAttempts = 5
	baseBackoff = time.Second
)

// Client embeds batches of text.
type Client struct {
	http    *http.Client
	baseURL string
	apiKey  string
	model   string
	dim     int
}

// Options configures the embedder.
type Options struct {
	BaseURL string
	APIKey  string
	Model   string
	// Dim asks the provider for a specific dimension. It must match the vector
	// column, or every insert fails.
	Dim int
}

func New(opts Options) (*Client, error) {
	if opts.BaseURL == "" {
		return nil, fmt.Errorf("embed: base url is empty")
	}
	if opts.APIKey == "" {
		return nil, fmt.Errorf("embed: api key is empty")
	}
	if opts.Model == "" {
		return nil, fmt.Errorf("embed: model is empty")
	}
	return &Client{
		http:    &http.Client{Timeout: 60 * time.Second},
		baseURL: opts.BaseURL,
		apiKey:  opts.APIKey,
		model:   opts.Model,
		dim:     opts.Dim,
	}, nil
}

func (c *Client) Model() string { return c.model }
func (c *Client) Dim() int      { return c.dim }

// Embed returns one vector per input, in the order given.
func (c *Client) Embed(ctx context.Context, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += batchSize {
		end := min(start+batchSize, len(texts))
		vecs, err := c.embedBatch(ctx, texts[start:end])
		if err != nil {
			return nil, err
		}
		out = append(out, vecs...)
	}
	return out, nil
}

type request struct {
	Model      string   `json:"model"`
	Input      []string `json:"input"`
	Dimensions int      `json:"dimensions,omitempty"`
}

type response struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) embedBatch(ctx context.Context, texts []string) ([][]float32, error) {
	body, err := json.Marshal(request{Model: c.model, Input: texts, Dimensions: c.dim})
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt := range maxAttempts {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(baseBackoff << (attempt - 1)):
			}
		}
		vecs, retryable, err := c.attempt(ctx, body, len(texts))
		if err == nil {
			return vecs, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}
	return nil, fmt.Errorf("embed: giving up after %d attempts: %w", maxAttempts, lastErr)
}

// attempt makes one call and reports whether a failure is worth retrying.
func (c *Client) attempt(ctx context.Context, body []byte, want int) ([][]float32, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, true, err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		// The provider usually says which thing is wrong — the model name, the
		// dimension, the quota — and those are precisely the mistakes this call
		// surfaces. "http 400" on its own sends somebody reading code instead
		// of the sentence that was already written for them.
		retry := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return nil, retry, fmt.Errorf("embed: http %d: %s", resp.StatusCode, said(resp.Body))
	}

	var decoded response
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return nil, true, err
	}
	if decoded.Error != nil {
		return nil, false, fmt.Errorf("embed: %s", decoded.Error.Message)
	}
	if len(decoded.Data) != want {
		return nil, false, fmt.Errorf("embed: got %d vectors for %d inputs", len(decoded.Data), want)
	}

	// Providers are allowed to answer out of order, and the index is the only
	// thing tying a vector back to its text.
	sort.Slice(decoded.Data, func(i, j int) bool { return decoded.Data[i].Index < decoded.Data[j].Index })

	vecs := make([][]float32, want)
	for i, d := range decoded.Data {
		if c.dim > 0 && len(d.Embedding) != c.dim {
			return nil, false, fmt.Errorf("embed: vector %d has %d dimensions, want %d", i, len(d.Embedding), c.dim)
		}
		for _, f := range d.Embedding {
			// A NaN reaching pgvector poisons every distance it takes part in,
			// and nothing downstream would report it.
			if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
				return nil, false, fmt.Errorf("embed: vector %d is not finite", i)
			}
		}
		vecs[i] = d.Embedding
	}
	return vecs, false, nil
}

// said is whatever the provider put in the body of a refusal, as its own error
// message where it wrote one and as raw text otherwise. Bounded, because an
// error is going into a log line and not everything answering on this address
// is the provider.
func said(r io.Reader) string {
	raw, err := io.ReadAll(io.LimitReader(r, 4<<10))
	if err != nil || len(raw) == 0 {
		return "no message"
	}
	var decoded response
	if err := json.Unmarshal(raw, &decoded); err == nil && decoded.Error != nil && decoded.Error.Message != "" {
		return decoded.Error.Message
	}
	return strings.TrimSpace(string(raw))
}
