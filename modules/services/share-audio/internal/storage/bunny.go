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

// BunnyClient implements Store against Bunny Edge Storage's HTTP API. Bunny is
// not S3-compatible: objects are GET/PUT/HEAD at
// {endpoint}/{zone}/{key} with an `AccessKey: <storage-zone password>` header.
// Public reads go through the linked pull zone (publicBase, e.g. b-cdn.net).
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

func (b *BunnyClient) objURL(key string) string {
	return b.endpoint + "/" + b.zone + "/" + strings.TrimLeft(key, "/")
}

func (b *BunnyClient) Exists(ctx context.Context, key string) (bool, error) {
	// Range-probe the first byte so a present source track isn't fully fetched.
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, b.objURL(key), nil)
	req.Header.Set("AccessKey", b.key)
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

func (b *BunnyClient) DownloadTo(ctx context.Context, key, dstPath string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, b.objURL(key), nil)
	req.Header.Set("AccessKey", b.key)
	resp, err := b.hc.Do(req)
	if err != nil {
		return fmt.Errorf("bunny get %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny get %s: HTTP %d", key, resp.StatusCode)
	}
	f, err := os.Create(dstPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", dstPath, err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("write %s: %w", dstPath, err)
	}
	return nil
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
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, b.objURL(key), f)
	req.Header.Set("AccessKey", b.key)
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

// BuildURL composes the public URL via the pull-zone base (always set for the
// Bunny backend — validated at config load).
func (b *BunnyClient) BuildURL(key string) string {
	return strings.TrimRight(b.publicBase, "/") + "/" + strings.TrimLeft(key, "/")
}
