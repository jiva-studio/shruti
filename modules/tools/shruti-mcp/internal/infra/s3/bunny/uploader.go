// Package bunny implements ports/s3.Uploader against Bunny.net Edge Storage.
//
// Bunny Storage is NOT S3-compatible: it speaks a plain HTTP API
// (PUT/GET/DELETE on https://<endpoint>/<zone>/<path>) authenticated with an
// `AccessKey` header carrying the storage-zone password — no AWS SigV4. So this
// provider talks HTTP directly instead of wrapping the AWS SDK. It is appended
// after the AWS/Yandex targets in the publish list, so every catalog publish
// mirrors config.json + db (and library media / artifacts) into Bunny Storage,
// keeping it in sync for the eventual origin swap S3 -> Bunny.
package bunny

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type Target struct {
	Name      string // "bunny"
	Zone      string // storage zone name, e.g. "shruti-engine-eu"
	Endpoint  string // base, e.g. "https://storage.bunnycdn.com"
	AccessKey string // storage-zone password (read+write key)
}

type Uploader struct {
	target Target
	client *http.Client
}

func New(t Target) (*Uploader, error) {
	if t.Zone == "" {
		return nil, fmt.Errorf("%s: zone required", t.Name)
	}
	if t.AccessKey == "" {
		return nil, fmt.Errorf("%s: access key required", t.Name)
	}
	if t.Endpoint == "" {
		t.Endpoint = "https://storage.bunnycdn.com"
	}
	t.Endpoint = strings.TrimRight(t.Endpoint, "/")
	if t.Name == "" {
		t.Name = "bunny"
	}
	return &Uploader{target: t, client: &http.Client{Timeout: 30 * time.Minute}}, nil
}

func (u *Uploader) Name() string   { return u.target.Name }
func (u *Uploader) Bucket() string { return u.target.Zone }

func (u *Uploader) objURL(key string) string {
	return u.target.Endpoint + "/" + u.target.Zone + "/" + strings.TrimLeft(key, "/")
}

func (u *Uploader) Put(ctx context.Context, key, contentType string, body io.Reader, size int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.objURL(key), body)
	if err != nil {
		return err
	}
	req.Header.Set("AccessKey", u.target.AccessKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if size >= 0 {
		req.ContentLength = size
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer drainClose(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny put %s: %s", key, resp.Status)
	}
	return nil
}

// Head reports size + existence by listing the parent directory (Bunny has no
// per-object HEAD). The returned "etag" is Bunny's SHA256 checksum — a
// different algorithm than S3's MD5 ETag, so callers must not cross-compare it
// against an AWS ETag; it is fine for the AWS primary's own self-consistency.
func (u *Uploader) Head(ctx context.Context, key string) (int64, string, bool, error) {
	key = strings.TrimLeft(key, "/")
	dir, file := path.Split(key)
	listURL := u.target.Endpoint + "/" + u.target.Zone + "/" + dir
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, listURL, nil)
	if err != nil {
		return 0, "", false, err
	}
	req.Header.Set("AccessKey", u.target.AccessKey)
	resp, err := u.client.Do(req)
	if err != nil {
		return 0, "", false, err
	}
	defer drainClose(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return 0, "", false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return 0, "", false, fmt.Errorf("bunny list %s: %s", dir, resp.Status)
	}
	var items []struct {
		ObjectName  string `json:"ObjectName"`
		Length      int64  `json:"Length"`
		Checksum    string `json:"Checksum"`
		IsDirectory bool   `json:"IsDirectory"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return 0, "", false, err
	}
	for _, it := range items {
		if it.ObjectName == file && !it.IsDirectory {
			return it.Length, strings.ToLower(it.Checksum), true, nil
		}
	}
	return 0, "", false, nil
}

func (u *Uploader) GetJSON(ctx context.Context, key string, out any) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.objURL(key), nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("AccessKey", u.target.AccessKey)
	resp, err := u.client.Do(req)
	if err != nil {
		return false, err
	}
	defer drainClose(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("bunny get %s: %s", key, resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return false, err
	}
	return true, nil
}

func drainClose(rc io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(rc, 1<<20))
	_ = rc.Close()
}

var _ s3port.Uploader = (*Uploader)(nil)
