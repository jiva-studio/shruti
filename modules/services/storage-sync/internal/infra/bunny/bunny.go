// Package bunny is the SourceStore adapter over Bunny Edge Storage's HTTP API.
//
// Bunny is NOT S3-compatible: it speaks a plain HTTP API — GET on a directory
// path returns a JSON listing, GET on an object returns the body, and every
// request authenticates with an `AccessKey` header. It exposes a per-object
// SHA-256 in the listing, which is what lets change detection work without
// re-downloading anything.
//
// There is no HEAD for a single object, so Stat lists the object's PARENT
// directory and picks the entry out — the same trick the ingest worker's Bunny
// blob adapter uses for its existence check.
package bunny

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium-storage-sync/internal/domain/mirror"
)

// DefaultEndpoint is Bunny's primary storage endpoint.
const DefaultEndpoint = "https://storage.bunnycdn.com"

// Store reads objects and listings from one Bunny storage zone.
type Store struct {
	zone        string
	key         string
	endpoint    string
	concurrency int
	hc          *http.Client
}

// Options configures the adapter.
type Options struct {
	Zone        string
	Key         string
	Endpoint    string // defaults to DefaultEndpoint
	Concurrency int    // bounds the parallel directory walk
	// Timeout bounds a single request. Transfers stream whole media files, so
	// this is generous by design.
	Timeout time.Duration
}

// New builds the adapter.
func New(o Options) (*Store, error) {
	if o.Zone == "" || o.Key == "" {
		return nil, fmt.Errorf("bunny: zone and key are required")
	}
	endpoint := o.Endpoint
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	conc := o.Concurrency
	if conc < 1 {
		conc = 16
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	return &Store{
		zone:        o.Zone,
		key:         o.Key,
		endpoint:    strings.TrimRight(endpoint, "/"),
		concurrency: conc,
		hc:          &http.Client{Timeout: timeout},
	}, nil
}

// entry is one row of Bunny's JSON directory listing (PascalCase on the wire).
type entry struct {
	ObjectName  string `json:"ObjectName"`
	Length      int64  `json:"Length"`
	IsDirectory bool   `json:"IsDirectory"`
	Checksum    string `json:"Checksum"`
	Path        string `json:"Path"`
}

// objectURL builds the absolute URL for a key (or a directory when it ends "/").
func (s *Store) objectURL(key string) string {
	return fmt.Sprintf("%s/%s/%s", s.endpoint, s.zone, strings.TrimLeft(key, "/"))
}

// listDir fetches one directory listing, retrying transient faults with an
// exponential backoff. A 404 is an empty directory, not an error.
func (s *Store) listDir(ctx context.Context, dir string) ([]entry, error) {
	url := s.objectURL(dir)
	if !strings.HasSuffix(url, "/") {
		url += "/"
	}
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("AccessKey", s.key)
		resp, err := s.hc.Do(req)
		if err != nil {
			lastErr = err
			if !sleepCtx(ctx, backoff(attempt)) {
				return nil, ctx.Err()
			}
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			return nil, nil
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("list %s: HTTP %d", dir, resp.StatusCode)
			if !sleepCtx(ctx, backoff(attempt)) {
				return nil, ctx.Err()
			}
			continue
		}
		var entries []entry
		err = json.NewDecoder(resp.Body).Decode(&entries)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		return entries, nil
	}
	return nil, lastErr
}

// keyOf resolves a listing entry to its full storage key. Bunny reports Path as
// "/<zone>/<dir>/", so the zone prefix is stripped and the object name appended.
func (s *Store) keyOf(e entry) string {
	rel := strings.TrimPrefix(e.Path, "/"+s.zone+"/")
	rel = strings.TrimPrefix(rel, "/")
	return rel + e.ObjectName
}

// Walk recursively lists every object under prefix. Directory fan-out is
// bounded by the configured concurrency; the first error encountered is
// returned once the walk settles.
func (s *Store) Walk(ctx context.Context, prefix string) (map[string]mirror.Object, error) {
	out := make(map[string]mirror.Object)
	var mu sync.Mutex
	sem := make(chan struct{}, s.concurrency)
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex

	var visit func(dir string)
	visit = func(dir string) {
		defer wg.Done()
		sem <- struct{}{}
		entries, err := s.listDir(ctx, dir)
		<-sem
		if err != nil {
			errMu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			errMu.Unlock()
			return
		}
		for _, e := range entries {
			key := s.keyOf(e)
			if e.IsDirectory {
				wg.Add(1)
				go visit(key + "/")
				continue
			}
			mu.Lock()
			out[key] = mirror.Object{
				Key:    key,
				Size:   e.Length,
				SHA256: strings.ToLower(e.Checksum),
			}
			mu.Unlock()
		}
	}
	wg.Add(1)
	go visit(strings.TrimLeft(prefix, "/"))
	wg.Wait()
	return out, firstErr
}

// Stat looks up a single object by listing its parent directory — Bunny has no
// per-object HEAD. found=false means the key is absent (not an error).
func (s *Store) Stat(ctx context.Context, key string) (mirror.Object, bool, error) {
	key = strings.TrimLeft(key, "/")
	dir, name := path.Split(key)
	entries, err := s.listDir(ctx, dir)
	if err != nil {
		return mirror.Object{}, false, err
	}
	for _, e := range entries {
		if e.IsDirectory || e.ObjectName != name {
			continue
		}
		return mirror.Object{
			Key:    key,
			Size:   e.Length,
			SHA256: strings.ToLower(e.Checksum),
		}, true, nil
	}
	return mirror.Object{}, false, nil
}

// Open streams an object body and reports its Content-Type. The caller closes
// the body.
func (s *Store) Open(ctx context.Context, key string) (io.ReadCloser, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.objectURL(key), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("AccessKey", s.key)
	resp, err := s.hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, "", fmt.Errorf("get %s: HTTP %d", key, resp.StatusCode)
	}
	return resp.Body, resp.Header.Get("Content-Type"), nil
}

func backoff(attempt int) time.Duration {
	return time.Duration(1<<attempt) * time.Second
}

// sleepCtx waits for d, returning false if the context is cancelled first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
