package content

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ShareAudioClient talks to the share-audio service: POST /excerpts to cut
// an mp3 slice and get back a public URL. The service answers 200 for a
// cache hit or 202 with the predicted URL for a fresh cut; since it exposes
// no status endpoint, we poll the URL with HEAD until it materializes.
type ShareAudioClient struct {
	base  string
	httpc *http.Client
}

func NewShareAudioClient(base string, httpc *http.Client) *ShareAudioClient {
	if httpc == nil {
		httpc = &http.Client{Timeout: 30 * time.Second}
	}
	return &ShareAudioClient{base: strings.TrimRight(base, "/"), httpc: httpc}
}

type excerptReq struct {
	SourceKey string `json:"source_key"`
	StartMs   int64  `json:"start_ms"`
	EndMs     int64  `json:"end_ms"`
	ExcerptID string `json:"excerpt_id,omitempty"`
}

type excerptResp struct {
	ExcerptID string `json:"excerpt_id"`
	URL       string `json:"url"`
	Ready     bool   `json:"ready"`
	Detail    string `json:"detail"`
}

// Excerpt requests a cut and returns a ready public URL. It blocks until the
// excerpt is available or ctx/timeout expires.
func (c *ShareAudioClient) Excerpt(ctx context.Context, sourceKey string, startMs, endMs int64, excerptID string) (string, error) {
	body, _ := json.Marshal(excerptReq{SourceKey: sourceKey, StartMs: startMs, EndMs: endMs, ExcerptID: excerptID})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/excerpts", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return "", fmt.Errorf("share-audio request: %w", err)
	}
	defer resp.Body.Close()

	var out excerptResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	switch resp.StatusCode {
	case http.StatusOK:
		return out.URL, nil
	case http.StatusAccepted:
		if out.URL == "" {
			return "", fmt.Errorf("share-audio 202 without url")
		}
		if err := c.waitReady(ctx, out.URL); err != nil {
			return "", err
		}
		return out.URL, nil
	default:
		if out.Detail != "" {
			return "", fmt.Errorf("share-audio %d: %s", resp.StatusCode, out.Detail)
		}
		return "", fmt.Errorf("share-audio status %d", resp.StatusCode)
	}
}

// waitReady polls the excerpt URL with HEAD until it returns 200.
func (c *ShareAudioClient) waitReady(ctx context.Context, url string) error {
	deadline := time.Now().Add(3 * time.Minute)
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
		resp, err := c.httpc.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("share-audio excerpt not ready after timeout: %s", url)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}
