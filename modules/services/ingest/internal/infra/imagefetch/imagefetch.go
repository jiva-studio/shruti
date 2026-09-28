// Package imagefetch downloads a published picture over HTTP.
package imagefetch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	// DefaultTimeout bounds one download end to end. A cover is a nicety and
	// must not hold a job up.
	DefaultTimeout = 15 * time.Second
	// DefaultMaxBytes caps how much of a response is read.
	DefaultMaxBytes = 8 * 1024 * 1024
)

// Client fetches images with a bounded time and size.
type Client struct {
	http     *http.Client
	maxBytes int64
}

// New builds a client. A zero timeout or size takes the default.
func New(timeout time.Duration, maxBytes int64) *Client {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	return &Client{http: &http.Client{Timeout: timeout}, maxBytes: maxBytes}
}

// FetchImage GETs url and returns at most the configured number of bytes and
// the response's content type. A status other than 200 is an error.
func (c *Client) FetchImage(ctx context.Context, url string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("cover GET %s: HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, c.maxBytes))
	if err != nil {
		return nil, "", err
	}
	return body, resp.Header.Get("Content-Type"), nil
}
