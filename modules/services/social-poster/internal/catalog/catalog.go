// Package catalog fetches the published Lectorium catalog SQLite DB from
// the CDN (the same one the mobile app downloads) and exposes read-only
// queries over it. One Catalog per region; a Manager holds the set.
//
// Fetch flow mirrors modules/kit/scripts/db-sync.sh:
//
//	GET <cdn>/public/config.json  -> { "databases":[{scheme,version},…] }
//	pick max(version) with the supported scheme
//	GET <cdn>/public/db/lectorium.<version>.db
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
	"sync"

	_ "modernc.org/sqlite" // pure-Go driver (CGO_ENABLED=0 build)

	"github.com/jiva-studio/lectorium-social-poster/internal/config"
)

const (
	appName    = "lectorium"
	configPath = "public/config.json"
	dbPrefix   = "public/db"
)

// Candidate is a unified piece of publishable content — either a
// daily_wisdom clip or a lecture — resolved with everything a post needs.
type Candidate struct {
	ID         string // wisdom id, or track id for lectures
	Kind       string // config.ContentDailyWisdom | config.ContentLecture
	TrackID    string
	Language   string
	Title      string
	Text       string // wisdom text, or lecture description
	StartMs    int64  // excerpt bounds (wisdom carries its own; lecture from 0)
	EndMs      int64
	AudioPath  string // S3 source_key handed to share-audio
	TopicID    string
	TopicName  string
	Author     string
	Location   string
	Date       string  // track date, ISO YYYY-MM-DD
	DurationMs int64   // full track audio duration
	Weight     float64 // max topic weight for the track ("trending" ordering)
}

// Catalog is a refreshable read-only handle to one region's catalog DB.
type Catalog struct {
	region   config.RegionConfig
	scheme   int
	cacheDir string
	httpc    *http.Client

	mu      sync.RWMutex
	db      *sql.DB
	version int
}

// New builds a Catalog for a region. Call Refresh before querying.
func New(region config.RegionConfig, scheme int, cacheDir string, httpc *http.Client) *Catalog {
	if httpc == nil {
		httpc = http.DefaultClient
	}
	return &Catalog{region: region, scheme: scheme, cacheDir: cacheDir, httpc: httpc}
}

type cdnConfig struct {
	Databases []struct {
		Scheme  int `json:"scheme"`
		Version int `json:"version"`
	} `json:"databases"`
}

// Refresh pulls the newest DB for the supported scheme and swaps it in.
// A no-op download (same version already cached & open) returns nil fast.
func (c *Catalog) Refresh(ctx context.Context) error {
	version, err := c.latestVersion(ctx)
	if err != nil {
		return err
	}

	c.mu.RLock()
	current := c.version
	c.mu.RUnlock()
	if current == version && c.currentDB() != nil {
		return nil
	}

	path := filepath.Join(c.cacheDir, fmt.Sprintf("%s.%d.db", appName, version))
	if _, statErr := os.Stat(path); statErr != nil {
		if err := c.download(ctx, version, path); err != nil {
			return err
		}
	}

	db, err := openRO(path)
	if err != nil {
		return err
	}

	c.mu.Lock()
	old := c.db
	c.db, c.version = db, version
	c.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	return nil
}

// Version reports the currently-open catalog version (0 if not loaded).
func (c *Catalog) Version() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.version
}

func (c *Catalog) latestVersion(ctx context.Context) (int, error) {
	url := c.region.CDNBase + "/" + configPath
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := c.httpc.Do(req)
	if err != nil {
		return 0, fmt.Errorf("fetch config.json: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("fetch config.json: status %d", resp.StatusCode)
	}
	var cfg cdnConfig
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return 0, fmt.Errorf("decode config.json: %w", err)
	}
	best := -1
	for _, d := range cfg.Databases {
		if d.Scheme == c.scheme && d.Version > best {
			best = d.Version
		}
	}
	if best < 0 {
		return 0, fmt.Errorf("no catalog DB for scheme %d on %s", c.scheme, c.region.CDNBase)
	}
	return best, nil
}

func (c *Catalog) download(ctx context.Context, version int, dst string) error {
	if err := os.MkdirAll(c.cacheDir, 0o755); err != nil {
		return fmt.Errorf("mkdir cache: %w", err)
	}
	url := fmt.Sprintf("%s/%s/%s.%d.db", c.region.CDNBase, dbPrefix, appName, version)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := c.httpc.Do(req)
	if err != nil {
		return fmt.Errorf("download db: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download db: status %d", resp.StatusCode)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return fmt.Errorf("create tmp db: %w", err)
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return fmt.Errorf("write db: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		return fmt.Errorf("finalize db: %w", err)
	}
	return nil
}

func (c *Catalog) currentDB() *sql.DB {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.db
}

func openRO(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", path))
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return db, nil
}

// Close releases the open DB handle.
func (c *Catalog) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db != nil {
		return c.db.Close()
	}
	return nil
}

// Manager holds one Catalog per configured region.
type Manager struct {
	regions map[string]*Catalog
}

// NewManager builds a Catalog for every region in the config.
func NewManager(cfg *config.Config, httpc *http.Client) *Manager {
	m := &Manager{regions: make(map[string]*Catalog)}
	for name, r := range cfg.Catalog.Regions {
		m.regions[name] = New(r, cfg.Catalog.Scheme, filepath.Join(cfg.Catalog.CacheDir, name), httpc)
	}
	return m
}

// Region returns the Catalog for a region name, or nil if unknown.
func (m *Manager) Region(name string) *Catalog { return m.regions[name] }

// RefreshAll refreshes every region, returning the first error (after
// attempting all, so one bad region doesn't block the others).
func (m *Manager) RefreshAll(ctx context.Context) error {
	var firstErr error
	for name, c := range m.regions {
		if err := c.Refresh(ctx); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("region %q: %w", name, err)
		}
	}
	return firstErr
}

// Close closes all region handles.
func (m *Manager) Close() {
	for _, c := range m.regions {
		_ = c.Close()
	}
}
