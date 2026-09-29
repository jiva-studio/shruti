// Package storage talks to the Bunny Edge Storage HTTP API: objects are
// GET/PUT at {endpoint}/{zone}/{key} with an `AccessKey: <storage-zone
// password>` header, and a GET on a path ending in `/` lists that directory.
package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

// Bunny reads sources and background clips from the storage zone and writes
// finished reels to it.
type Bunny struct {
	endpoint string
	zone     string
	key      string
	hc       *http.Client
}

func NewBunny(zone, key, endpoint string) *Bunny {
	if endpoint == "" {
		endpoint = "https://storage.bunnycdn.com"
	}
	return &Bunny{
		endpoint: strings.TrimRight(endpoint, "/"),
		zone:     zone,
		key:      key,
		hc:       &http.Client{Timeout: 10 * time.Minute},
	}
}

// newRequest builds an authenticated request for key; suffix is appended to
// the escaped URL ("/" lists a directory).
func (b *Bunny) newRequest(ctx context.Context, method, key, suffix string, body io.Reader) (*http.Request, error) {
	u, err := objectURL(b.endpoint, b.zone, key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u+suffix, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("AccessKey", b.key)
	return req, nil
}

// drain empties and closes a response body so the connection can be reused;
// a failed drain only costs the connection.
func drain(resp *http.Response) {
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		slog.Debug("bunny_drain_failed", "err", err.Error())
	}
	if err := resp.Body.Close(); err != nil {
		slog.Debug("bunny_close_failed", "err", err.Error())
	}
}

type listedObject struct {
	ObjectName  string `json:"ObjectName"`
	IsDirectory bool   `json:"IsDirectory"`
}

// ListFiles returns the full keys of the files directly under dir, sorted.
// Subdirectories are skipped; a directory that does not exist lists empty.
func (b *Bunny) ListFiles(ctx context.Context, dir string) ([]string, error) {
	dir = strings.TrimSuffix(dir, "/")
	req, err := b.newRequest(ctx, http.MethodGet, dir, "/", nil)
	if err != nil {
		return nil, fmt.Errorf("bunny list %s: %w", dir, err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := b.hc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bunny list %s: %w", dir, err)
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bunny list %s: HTTP %d", dir, resp.StatusCode)
	}
	var objects []listedObject
	if err := json.NewDecoder(resp.Body).Decode(&objects); err != nil {
		return nil, fmt.Errorf("bunny list %s: decode: %w", dir, err)
	}
	keys := make([]string, 0, len(objects))
	for _, o := range objects {
		if o.IsDirectory {
			continue
		}
		keys = append(keys, dir+"/"+o.ObjectName)
	}
	sort.Strings(keys)
	return keys, nil
}

// DownloadTo streams the object at key into dstPath.
func (b *Bunny) DownloadTo(ctx context.Context, key, dstPath string) error {
	req, err := b.newRequest(ctx, http.MethodGet, key, "", nil)
	if err != nil {
		return fmt.Errorf("bunny get %s: %w", key, err)
	}
	resp, err := b.hc.Do(req)
	if err != nil {
		return fmt.Errorf("bunny get %s: %w", key, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny get %s: HTTP %d", key, resp.StatusCode)
	}
	f, err := os.Create(dstPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", dstPath, err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return fmt.Errorf("write %s: %w", dstPath, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", dstPath, err)
	}
	return nil
}

// Put uploads localPath to key.
func (b *Bunny) Put(ctx context.Context, key, localPath, contentType string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open %s: %w", localPath, err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat %s: %w", localPath, err)
	}
	req, err := b.newRequest(ctx, http.MethodPut, key, "", f)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = st.Size()
	resp, err := b.hc.Do(req)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny put %s: HTTP %d", key, resp.StatusCode)
	}
	return nil
}
