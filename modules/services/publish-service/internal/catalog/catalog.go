// Package catalog reads the published corpus catalog `current.db` — the SQLite
// artifact the published-corpus build ships — to learn which track ids are live
// in the public corpus. The publish-service reconciles its own `tracks` ledger
// against this set: a track present here that it holds as unpublished is
// promoted.
//
// The image ships FROM scratch and CGO-free, so this package uses the pure-Go
// modernc.org/sqlite driver (never mattn/go-sqlite3).
package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // pure-Go, CGO-free SQLite driver
)

// Fetcher fetches the raw catalog bytes from wherever they live.
type Fetcher interface {
	// Fetch returns the current.db bytes.
	Fetch(ctx context.Context) ([]byte, error)
}

// HTTPFetcher fetches current.db from an HTTP(S) URL.
type HTTPFetcher struct {
	URL    string
	Client *http.Client
}

// NewHTTPFetcher builds an HTTPFetcher with a sane default client.
func NewHTTPFetcher(url string) *HTTPFetcher {
	return &HTTPFetcher{URL: url, Client: &http.Client{Timeout: 60 * time.Second}}
}

func (f *HTTPFetcher) Fetch(ctx context.Context) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.URL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch catalog %s: %w", f.URL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch catalog %s: status %d", f.URL, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// blobGetter is the S3 surface the S3Fetcher needs.
type blobGetter interface {
	Get(ctx context.Context, key string) ([]byte, error)
}

// S3Fetcher fetches current.db from an S3 object key.
type S3Fetcher struct {
	Blob blobGetter
	Key  string
}

// NewS3Fetcher builds an S3Fetcher.
func NewS3Fetcher(blob blobGetter, key string) *S3Fetcher {
	return &S3Fetcher{Blob: blob, Key: key}
}

func (f *S3Fetcher) Fetch(ctx context.Context) ([]byte, error) {
	return f.Blob.Get(ctx, f.Key)
}

// Reader loads the catalog and exposes its published track ids.
type Reader struct {
	fetcher Fetcher
}

// NewReader wires a Reader over a Fetcher.
func NewReader(f Fetcher) *Reader { return &Reader{fetcher: f} }

// PublishedTrackIDs fetches current.db and returns every track id it lists. The
// bytes are written to a temp file because the SQLite driver opens a path.
func (r *Reader) PublishedTrackIDs(ctx context.Context) ([]string, error) {
	blob, err := r.fetcher.Fetch(ctx)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "corpus-catalog-")
	if err != nil {
		return nil, fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "current.db")
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		return nil, fmt.Errorf("write catalog: %w", err)
	}
	return readTrackIDs(ctx, path)
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
