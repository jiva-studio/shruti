package refresh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	domaincatalog "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/cdn"
)

// UseCase downloads the latest scheme-compatible catalog DB and stores it
// under out/artifacts/catalog/. See plan §"Refresh-флоу".
type UseCase struct {
	OutDir          string
	SupportedScheme int
	CDN             cdn.Source
	SchemeReader    catalogport.SchemeReader // verify the downloaded snapshot's scheme
	OpMutex         *sync.Mutex              // shared with publish
}

type Result struct {
	Version    int64    `json:"version"`
	Scheme     int      `json:"scheme"`
	SnapshotPath string `json:"snapshot_path"`
	CurrentPath  string `json:"current_path"`
	Refreshed    bool   `json:"refreshed"` // true if we actually downloaded
}

type configManifest struct {
	Databases []struct {
		Version int64 `json:"version"`
		Scheme  int   `json:"scheme"`
	} `json:"databases"`
}

type catalogMeta struct {
	DownloadedFromVersion int64  `json:"downloaded_from_version"`
	Scheme                int    `json:"scheme"`
	DownloadedAt          string `json:"downloaded_at"`
	SnapshotSHA256        string `json:"snapshot_sha256"`
	// Modified is set to true by mutating use cases (commit, dictcrud)
	// and reset to false by publish. It's the authoritative signal for
	// "current.db has unsaved changes" — sha256 of the live DB file
	// includes WAL sidecars and is unreliable.
	Modified         bool   `json:"modified"`
	PublishedVersion int64  `json:"published_version,omitempty"`
	PublishedAt      string `json:"published_at,omitempty"`
}

func (uc UseCase) catalogDir() string {
	return filepath.Join(uc.OutDir, "artifacts", "catalog")
}
func (uc UseCase) currentPath() string  { return filepath.Join(uc.catalogDir(), "current.db") }
func (uc UseCase) metaPath() string     { return filepath.Join(uc.catalogDir(), "meta.json") }
func (uc UseCase) snapshotPath(v int64) string {
	return filepath.Join(uc.catalogDir(), fmt.Sprintf("snapshot.%d.db", v))
}

// Run downloads the newest scheme-compatible DB. force=true overwrites
// current.db even if it has unsaved changes (a backup is made).
func (uc UseCase) Run(ctx context.Context, force bool) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if err := os.MkdirAll(uc.catalogDir(), 0o755); err != nil {
		return Result{}, err
	}

	// 1. config.json
	var cfg configManifest
	if err := uc.CDN.GetJSON(ctx, "public/config.json", &cfg); err != nil {
		return Result{}, fmt.Errorf("fetch config.json: %w", err)
	}
	// 2. filter by scheme + pick max version
	var pick struct {
		version int64
		scheme  int
	}
	for _, d := range cfg.Databases {
		if d.Scheme == uc.SupportedScheme && d.Version > pick.version {
			pick.version = d.Version
			pick.scheme = d.Scheme
		}
	}
	if pick.version == 0 {
		return Result{}, fmt.Errorf("no compatible database in config.json (need scheme=%d, available: %v)",
			uc.SupportedScheme, cfg.Databases)
	}

	// 3. Already have this snapshot? Skip download (still possibly resync current.db).
	snapPath := uc.snapshotPath(pick.version)
	curPath := uc.currentPath()
	curExists := fileExists(curPath)

	snapExists := fileExists(snapPath)
	var snapHash string
	var refreshed bool
	if !snapExists {
		// 4. Download snapshot.
		body, err := uc.CDN.GetFile(ctx, fmt.Sprintf("public/db/shruti.%d.db", pick.version))
		if err != nil {
			return Result{}, fmt.Errorf("fetch db: %w", err)
		}
		defer body.Close()
		snapHash, err = atomicWriteHashed(snapPath, body)
		if err != nil {
			return Result{}, err
		}
		refreshed = true
	} else {
		var err error
		snapHash, err = sha256File(snapPath)
		if err != nil {
			return Result{}, fmt.Errorf("rehash existing snapshot: %w", err)
		}
	}

	// 5. Verify scheme.
	gotScheme, err := uc.SchemeReader.ReadScheme(ctx, snapPath)
	if err != nil {
		return Result{}, fmt.Errorf("read snapshot scheme: %w", err)
	}
	if gotScheme != uc.SupportedScheme {
		return Result{}, fmt.Errorf("MCP supports scheme %d, downloaded %d; rebuild MCP",
			uc.SupportedScheme, gotScheme)
	}

	// 6. Decide whether to overwrite current.db.
	var prior catalogMeta
	if metaRaw, err := os.ReadFile(uc.metaPath()); err == nil {
		_ = json.Unmarshal(metaRaw, &prior)
	}

	switch {
	case !curExists:
		// First-time refresh.
		if err := copyFile(snapPath, curPath); err != nil {
			return Result{}, err
		}
	case prior.Modified && !force:
		return Result{}, fmt.Errorf("current.db has unsaved changes (meta.modified=true); publish first or use force=true")
	case prior.DownloadedFromVersion == pick.version && !prior.Modified:
		// Already current — no-op (don't even rewrite the file, WAL would just churn).
	default:
		// We have an older but un-modified current.db, OR force is set.
		if force && prior.Modified {
			backup := uc.snapshotPath(pick.version) + ".before-refresh"
			_ = os.Rename(curPath, backup)
		}
		if err := copyFile(snapPath, curPath); err != nil {
			return Result{}, err
		}
	}

	// 7. Write meta.json
	meta := catalogMeta{
		DownloadedFromVersion: pick.version,
		Scheme:                gotScheme,
		DownloadedAt:          time.Now().UTC().Format(time.RFC3339),
		SnapshotSHA256:        snapHash,
	}
	metaRaw, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(uc.metaPath(), metaRaw, 0o644); err != nil {
		return Result{}, err
	}

	return Result{
		Version:      pick.version,
		Scheme:       gotScheme,
		SnapshotPath: snapPath,
		CurrentPath:  curPath,
		Refreshed:    refreshed,
	}, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func atomicWriteHashed(dst string, src io.Reader) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".tmp-*")
	if err != nil {
		return "", err
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	h := sha256.New()
	mw := io.MultiWriter(tmp, h)
	if _, err := io.Copy(mw, src); err != nil {
		return "", err
	}
	if err := tmp.Sync(); err != nil {
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := io.Copy(tmp, in); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

// SortedDatabases returns config.databases sorted newest first (used by tests).
func SortedDatabases(m configManifest) []struct{ Version int64; Scheme int } {
	out := make([]struct{ Version int64; Scheme int }, len(m.Databases))
	for i, d := range m.Databases {
		out[i] = struct{ Version int64; Scheme int }{d.Version, d.Scheme}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	return out
}

// avoid unused import (sqlitecatalog & domaincatalog already in use above)
var _ = domaincatalog.SupportedDBScheme
