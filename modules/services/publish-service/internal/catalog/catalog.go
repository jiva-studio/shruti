// Package catalog reads the published corpus catalog — the SQLite artifact the
// published-corpus build ships — to learn which track ids are live in the public
// corpus. The publish-service reconciles its own `tracks` ledger against this
// set: a track present here that it holds as unpublished is promoted.
//
// There is no fixed catalog filename. `catalog.publish` uploads every build
// under a version-stamped key (`public/db/shruti.{version}.db`) and then
// flips `public/config.json` to advertise it, so the live version has to be
// resolved from that manifest on every read — exactly as the corpus-mcp
// bootstrap does. `current.db` is only the producer's local working file and
// never exists on the CDN.
//
// The image ships FROM scratch and CGO-free, so this package uses the pure-Go
// modernc.org/sqlite driver (never mattn/go-sqlite3).
package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite" // pure-Go, CGO-free SQLite driver
)

// manifestKey is the published manifest that advertises the live catalog
// version; catalogKey renders the version-stamped catalog object key. Both are
// contract with `catalog.publish` (shruti-mcp).
const manifestKey = "public/config.json"

func catalogKey(version string) string { return "public/db/shruti." + version + ".db" }

// manifest models only the field this service needs out of config.json.
type manifest struct {
	Databases []struct {
		Version json.Number `json:"version"`
	} `json:"databases"`
}

// latestVersion returns the numerically-greatest advertised version (versions
// are monotonic timestamp integers like 20260809133448).
func (m manifest) latestVersion() string {
	best := ""
	var bestN int64 = -1
	for _, d := range m.Databases {
		v := d.Version.String()
		if v == "" {
			continue
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			if v > best {
				best = v
			}
			continue
		}
		if n > bestN {
			bestN, best = n, v
		}
	}
	return best
}

func parseManifest(raw []byte) (string, error) {
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", fmt.Errorf("decode %s: %w", manifestKey, err)
	}
	v := m.latestVersion()
	if v == "" {
		return "", fmt.Errorf("%s advertises no catalog database", manifestKey)
	}
	return v, nil
}

// Snapshot is the outcome of one fetch: either the bytes of the live catalog
// version, or a report that the caller's version is still the live one and no
// download happened.
type Snapshot struct {
	Version   string
	Body      []byte
	Unchanged bool
}

// Fetcher fetches the live catalog from wherever it is published.
type Fetcher interface {
	// Fetch resolves the live catalog version and returns its bytes. When have
	// is non-empty and still the live version, it returns Unchanged with no
	// Body — the caller already holds a parse of that version.
	Fetch(ctx context.Context, have string) (Snapshot, error)
}

// HTTPFetcher reads the manifest and the catalog over public HTTP(S), rooted at
// the media base URL (the CDN origin the app itself reads from).
type HTTPFetcher struct {
	Base   string
	Client *http.Client

	mu           sync.Mutex
	manifestETag string
	version      string
}

// NewHTTPFetcher builds an HTTPFetcher with a sane default client.
func NewHTTPFetcher(base string) *HTTPFetcher {
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	return &HTTPFetcher{Base: base, Client: &http.Client{Timeout: 60 * time.Second}}
}

func (f *HTTPFetcher) Fetch(ctx context.Context, have string) (Snapshot, error) {
	version, err := f.resolve(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	if have != "" && have == version {
		return Snapshot{Version: version, Unchanged: true}, nil
	}
	body, err := f.get(ctx, catalogKey(version))
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{Version: version, Body: body}, nil
}

// resolve reads config.json and returns the live catalog version. The request
// is conditional on the ETag of the last manifest we parsed, so a steady-state
// tick costs one 304 and no body at all.
func (f *HTTPFetcher) resolve(ctx context.Context) (string, error) {
	f.mu.Lock()
	etag, cached := f.manifestETag, f.version
	f.mu.Unlock()
	if cached == "" {
		etag = ""
	}

	url := f.Base + "/" + manifestKey
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified && cached != "" {
		return cached, nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: status %d", url, resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("fetch %s: %w", url, err)
	}
	version, err := parseManifest(raw)
	if err != nil {
		return "", err
	}
	f.mu.Lock()
	f.manifestETag, f.version = resp.Header.Get("ETag"), version
	f.mu.Unlock()
	return version, nil
}

func (f *HTTPFetcher) get(ctx context.Context, key string) ([]byte, error) {
	url := f.Base + "/" + key
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch catalog %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch catalog %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// blobGetter is the blob-store surface the BlobFetcher needs.
type blobGetter interface {
	Get(ctx context.Context, key string) ([]byte, error)
}

// BlobFetcher reads the same two objects straight from the blob backend (Bunny
// Edge Storage or S3) for deployments with no public media URL configured.
type BlobFetcher struct {
	Blob blobGetter
}

// NewBlobFetcher builds a BlobFetcher over the configured blob backend.
func NewBlobFetcher(blob blobGetter) *BlobFetcher { return &BlobFetcher{Blob: blob} }

func (f *BlobFetcher) Fetch(ctx context.Context, have string) (Snapshot, error) {
	raw, err := f.Blob.Get(ctx, manifestKey)
	if err != nil {
		return Snapshot{}, fmt.Errorf("get %s: %w", manifestKey, err)
	}
	version, err := parseManifest(raw)
	if err != nil {
		return Snapshot{}, err
	}
	if have != "" && have == version {
		return Snapshot{Version: version, Unchanged: true}, nil
	}
	key := catalogKey(version)
	body, err := f.Blob.Get(ctx, key)
	if err != nil {
		return Snapshot{}, fmt.Errorf("get %s: %w", key, err)
	}
	return Snapshot{Version: version, Body: body}, nil
}

// Reader loads the catalog and exposes its published track ids. It remembers
// the version it last parsed so an unchanged catalog costs neither a download
// nor a re-parse.
type Reader struct {
	fetcher Fetcher

	mu      sync.Mutex
	version string
	ids     []string
}

// NewReader wires a Reader over a Fetcher.
func NewReader(f Fetcher) *Reader { return &Reader{fetcher: f} }

// PublishedTrackIDs fetches the live catalog and returns every track id it
// lists. The bytes are written to a temp file because the SQLite driver opens a
// path.
func (r *Reader) PublishedTrackIDs(ctx context.Context) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	snap, err := r.fetcher.Fetch(ctx, r.version)
	if err != nil {
		return nil, err
	}
	if snap.Unchanged {
		return r.ids, nil
	}
	dir, err := os.MkdirTemp("", "corpus-catalog-")
	if err != nil {
		return nil, fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "catalog.db")
	if err := os.WriteFile(path, snap.Body, 0o600); err != nil {
		return nil, fmt.Errorf("write catalog: %w", err)
	}
	ids, err := readTrackIDs(ctx, path)
	if err != nil {
		return nil, err
	}
	r.version, r.ids = snap.Version, ids
	return ids, nil
}

// readTrackIDs opens the catalog read-only and reads the `tracks.id` column.
// The published catalog contract exposes a `tracks` table keyed by `id`.
func readTrackIDs(ctx context.Context, path string) ([]string, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open catalog: %w", err)
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `SELECT id FROM tracks`)
	if err != nil {
		return nil, fmt.Errorf("query tracks: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan track id: %w", err)
		}
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}
