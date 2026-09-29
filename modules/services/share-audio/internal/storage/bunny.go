package storage

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// BunnyClient implements Store against Bunny Edge Storage's HTTP API: objects
// are GET/PUT at {endpoint}/{zone}/{key} with an `AccessKey: <storage-zone
// password>` header. Public reads go through the linked pull zone (publicBase).
type BunnyClient struct {
	endpoint   string
	zone       string
	key        string
	publicBase string
	hc         *http.Client
}

func NewBunny(zone, key, endpoint, publicBase string) *BunnyClient {
	if endpoint == "" {
		endpoint = "https://storage.bunnycdn.com"
	}
	return &BunnyClient{
		endpoint:   strings.TrimRight(endpoint, "/"),
		zone:       zone,
		key:        key,
		publicBase: publicBase,
		hc:         &http.Client{Timeout: 10 * time.Minute},
	}
}

func (b *BunnyClient) newRequest(ctx context.Context, method, key string, body io.Reader) (*http.Request, error) {
	u, err := objectURL(b.endpoint, b.zone, key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("AccessKey", b.key)
	return req, nil
}

func (b *BunnyClient) Exists(ctx context.Context, key string) (bool, error) {
	// Range-probe the first byte so a present object isn't fully fetched.
	req, err := b.newRequest(ctx, http.MethodGet, key, nil)
	if err != nil {
		return false, fmt.Errorf("bunny exists %s: %w", key, err)
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := b.hc.Do(req)
	if err != nil {
		return false, err
	}
	// Drained so the connection can be reused; a failed drain only costs it.
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); resp.Body.Close() }()
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("bunny exists %s: HTTP %d", key, resp.StatusCode)
	}
}

func (b *BunnyClient) Upload(ctx context.Context, key, localPath, contentType, _ string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", localPath, err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	req, err := b.newRequest(ctx, http.MethodPut, key, f)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = st.Size()
	resp, err := b.hc.Do(req)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	// Drained so the connection can be reused; a failed drain only costs it.
	defer func() { _, _ = io.Copy(io.Discard, resp.Body); resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny put %s: HTTP %d", key, resp.StatusCode)
	}
	return nil
}

// BuildURL composes the public URL via the pull-zone base, which config load
// requires.
func (b *BunnyClient) BuildURL(key string) string {
	return strings.TrimRight(b.publicBase, "/") + "/" + strings.TrimLeft(key, "/")
}
