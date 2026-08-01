// Package bunny implements ports.BlobStore against Bunny.net Edge Storage.
//
// Bunny Storage is NOT S3-compatible: it speaks a plain HTTP API
// (PUT/GET/DELETE on https://<endpoint>/<zone>/<key>) authenticated with an
// `AccessKey` header carrying the storage-zone password — no AWS SigV4. On the
// global deployment the public CDN (b-cdn) serves artifacts straight from the
// Bunny storage zone, so the ingest worker MUST write here (not to S3) for the
// app and chat to fetch the audio + transcript. Mirrors the corpus pipeline's
// bunny uploader (modules/tools/lectorium-mcp/internal/infra/s3/bunny).
package bunny

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
)

// Store is the Bunny-Edge-Storage-backed BlobStore.
type Store struct {
	zone      string
	endpoint  string
	accessKey string
	client    *http.Client
}

// New builds a Store. endpoint defaults to the Bunny Storage origin; zone is the
// storage-zone name and accessKey its read+write password.
func New(zone, endpoint, accessKey string) (*Store, error) {
	if zone == "" {
		return nil, fmt.Errorf("bunny: storage zone required")
	}
	if accessKey == "" {
		return nil, fmt.Errorf("bunny: access key required")
	}
	if endpoint == "" {
		endpoint = "https://storage.bunnycdn.com"
	}
	return &Store{
		zone:      zone,
		endpoint:  strings.TrimRight(endpoint, "/"),
		accessKey: accessKey,
		client:    &http.Client{Timeout: 30 * time.Minute},
	}, nil
}

func (s *Store) objURL(key string) string {
	return s.endpoint + "/" + s.zone + "/" + strings.TrimLeft(key, "/")
}

// Put writes body at key. Bunny returns 201 Created on success.
func (s *Store) Put(ctx context.Context, key string, body []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, s.objURL(key), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("AccessKey", s.accessKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.ContentLength = int64(len(body))
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("bunny put %s: %w", key, err)
	}
	defer drain(resp.Body)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bunny put %s: %s", key, resp.Status)
	}
	return nil
}

// Get reads the object at key (used by the translate op to load an already-
// stored transcript). Bunny serves the body straight from the storage zone.
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.objURL(key), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("AccessKey", s.accessKey)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bunny get %s: %w", key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bunny get %s: %s", key, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

// Exists reports whether key is present. Bunny has no per-object HEAD, so it
// lists the parent directory and looks for the file entry.
func (s *Store) Exists(ctx context.Context, key string) (bool, error) {
	key = strings.TrimLeft(key, "/")
	dir, file := path.Split(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint+"/"+s.zone+"/"+dir, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("AccessKey", s.accessKey)
	resp, err := s.client.Do(req)
	if err != nil {
		return false, err
	}
	defer drain(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("bunny list %s: %s", dir, resp.Status)
	}
	var items []struct {
		ObjectName  string `json:"ObjectName"`
		IsDirectory bool   `json:"IsDirectory"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&items); err != nil {
		return false, err
	}
	for _, it := range items {
		if it.ObjectName == file && !it.IsDirectory {
			return true, nil
		}
	}
	return false, nil
}

func drain(rc io.ReadCloser) {
	_, _ = io.Copy(io.Discard, io.LimitReader(rc, 1<<20))
	_ = rc.Close()
}
