// Package catalog reads library-wide totals (lecture count + total duration)
// from the CDN-published catalog SQLite — the same artifact corpus-mcp and the
// chat indexer use (${MEDIA_BASE_URL}/public/db/lectorium.{version}.db, version
// from the /public/config.json manifest).
//
// Analytics has no local copy of the file, so it self-fetches like the other
// services. The catalog changes only when a new version is published, so the
// download is ephemeral: read the manifest, and only when the latest version
// differs from what we've computed do we stream the DB to a temp file, run two
// aggregate queries, cache the result in memory, and delete the file. A restart
// simply recomputes once.
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

	_ "modernc.org/sqlite" // pure-Go SQLite driver, name "sqlite"; works in scratch
)

const sqliteMagic = "SQLite format 3\x00"

// Totals is the computed library rollup for one catalog version.
type Totals struct {
	LectureCount    int64  `json:"lecture_count"`
	TotalDurationMs int64  `json:"total_duration_ms"`
	Version         string `json:"version"`
}

// Provider fetches + caches the catalog totals. Safe for concurrent use.
type Provider struct {
	mediaBase string
	http      *http.Client

	mu     sync.Mutex
	cached *Totals

	// computeMu serializes the download+recompute so concurrent callers (e.g.
	// the boot warm and the first request) don't race on the temp file or
	// download 26 MB twice — the loser finds the cache warm and returns it.
	computeMu sync.Mutex
}

// New builds a Provider against a Bunny-CDN media base (e.g.
// https://akds-lectorium.b-cdn.net).
func New(mediaBase string) *Provider {
	return &Provider{
		mediaBase: trimSlash(mediaBase),
		http:      &http.Client{Timeout: 5 * time.Minute},
	}
}

// Totals returns the current library rollup. It reads the small manifest each
// call; only a version change triggers a fresh DB download + recompute. On a
// transient manifest/download error a previously-cached value is served rather
// than failing the report.
func (p *Provider) Totals(ctx context.Context) (Totals, error) {
	version, err := p.latestVersion(ctx)
	if err != nil {
		if c := p.snapshot(); c != nil {
			return *c, nil
		}
		return Totals{}, err
	}

	if c := p.snapshot(); c != nil && c.Version == version {
		return *c, nil
	}

	// Serialize the expensive download+compute; re-check the cache after
	// acquiring the lock in case another caller just populated it.
	p.computeMu.Lock()
	defer p.computeMu.Unlock()
	if c := p.snapshot(); c != nil && c.Version == version {
		return *c, nil
	}

	t, err := p.computeForVersion(ctx, version)
	if err != nil {
		if c := p.snapshot(); c != nil {
			return *c, nil // serve stale rather than error out
		}
		return Totals{}, err
	}

	p.mu.Lock()
	p.cached = &t
	p.mu.Unlock()
	return t, nil
}

func (p *Provider) snapshot() *Totals {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cached
}

type manifest struct {
	Databases []struct {
		Version json.Number `json:"version"`
	} `json:"databases"`
}

func (p *Provider) latestVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.mediaBase+"/public/config.json", nil)
	if err != nil {
		return "", err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("config.json: HTTP %d", resp.StatusCode)
	}
	var m manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return "", err
	}
	best := ""
	var bestN int64 = -1
	for _, d := range m.Databases {
		v := d.Version.String()
		if v == "" {
			continue
		}
		// Versions are monotonic timestamp integers (e.g. 20260626133744).
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			if n > bestN {
				bestN, best = n, v
			}
		} else if v > best {
			best = v
		}
	}
	if best == "" {
		return "", fmt.Errorf("manifest has no catalog databases")
	}
	return best, nil
}

func (p *Provider) computeForVersion(ctx context.Context, version string) (Totals, error) {
	dir := filepath.Join(os.TempDir(), "analytics-catalog")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Totals{}, err
	}
	dbPath := filepath.Join(dir, "catalog.db")
	defer os.Remove(dbPath)

	url := fmt.Sprintf("%s/public/db/lectorium.%s.db", p.mediaBase, version)
	if err := p.download(ctx, url, dbPath); err != nil {
		return Totals{}, err
	}

	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return Totals{}, err
	}
	defer db.Close()

	var count, durationMs int64
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tracks WHERE hidden = 0`,
	).Scan(&count); err != nil {
		return Totals{}, fmt.Errorf("count tracks: %w", err)
	}
	// One duration per lecture (the longest language variant) so multi-language
	// tracks aren't multiplied; hidden lectures excluded.
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(d), 0) FROM (
		    SELECT MAX(tv.audio_duration) AS d
		    FROM track_variants tv
		    JOIN tracks t ON t.id = tv.track_id
		    WHERE t.hidden = 0
		    GROUP BY tv.track_id
		)`,
	).Scan(&durationMs); err != nil {
		return Totals{}, fmt.Errorf("sum duration: %w", err)
	}

	return Totals{LectureCount: count, TotalDurationMs: durationMs, Version: version}, nil
}

// download streams url to a temp file, verifies the SQLite header, and renames
// it into place (atomic on the same fs). Mirrors corpus-mcp's downloader.
func (p *Provider) download(ctx context.Context, url, dest string) error {
	tmp := dest + ".tmp"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := verifySQLite(tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func verifySQLite(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	buf := make([]byte, len(sqliteMagic))
	if _, err := io.ReadFull(f, buf); err != nil {
		return fmt.Errorf("read header of %s: %w", path, err)
	}
	if string(buf) != sqliteMagic {
		return fmt.Errorf("%s is not a SQLite database (bad magic)", path)
	}
	return nil
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
