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

// BunnyUploader writes finished reels to Bunny Edge Storage's HTTP API
// ({endpoint}/{zone}/{key} with an `AccessKey` header). Only the public,
// client-facing reel OUTPUT moves to Bunny; source/background reads and the
// SpeechKit presigned-URL flow stay on the S3-compatible client (Bunny has no
// presigning). nil *BunnyUploader = keep uploading output to S3.
type BunnyUploader struct {
	endpoint string
	zone     string
	key      string
	hc       *http.Client
}

func NewBunnyUploader(zone, key, endpoint string) *BunnyUploader {
	if endpoint == "" {
		endpoint = "https://storage.bunnycdn.com"
	}
	return &BunnyUploader{
		endpoint: strings.TrimRight(endpoint, "/"),
		zone:     zone,
		key:      key,
		hc:       &http.Client{Timeout: 10 * time.Minute},
	}
}

func (b *BunnyUploader) Put(ctx context.Context, key, localPath, contentType string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", localPath, err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	url := b.endpoint + "/" + b.zone + "/" + strings.TrimLeft(key, "/")
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, url, f)
	req.Header.Set("AccessKey", b.key)
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = st.Size()
	resp, err := b.hc.Do(req)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	defer func() { io.Copy(io.Discard, resp.Body); resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny put %s: HTTP %d", key, resp.StatusCode)
	}
	return nil
}
