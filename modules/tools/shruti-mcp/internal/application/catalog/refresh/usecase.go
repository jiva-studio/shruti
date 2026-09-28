// Package refresh replaces the working catalog with the newest published
// snapshot of the scheme this binary supports.
package refresh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/cdn"
	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
)

// UseCase downloads the newest scheme-compatible catalog into
// out/artifacts/catalog/ and installs it as the working catalog.
type UseCase struct {
	OutDir          string
	SupportedScheme int
	CDN             cdn.Source
	SchemeReader    catalogport.SchemeReader
	Catalog         catalogport.Installer
	OpMutex         *sync.Mutex // shared with publish
	Clock           clockport.Clock
}

type Result struct {
	Version      int64  `json:"version"`
	Scheme       int    `json:"scheme"`
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

// catalogMeta is meta.json beside current.db. Modified is set by every write
// to the catalog and cleared by publish: it is the record of unpublished
// changes, since a hash of the live file would include its write-ahead log.
type catalogMeta struct {
	DownloadedFromVersion int64  `json:"downloaded_from_version"`
	Scheme                int    `json:"scheme"`
	DownloadedAt          string `json:"downloaded_at"`
	SnapshotSHA256        string `json:"snapshot_sha256"`
	Modified              bool   `json:"modified"`
	PublishedVersion      int64  `json:"published_version,omitempty"`
	PublishedAt           string `json:"published_at,omitempty"`
}

func (uc UseCase) catalogDir() string {
	return filepath.Join(uc.OutDir, "artifacts", "catalog")
}
func (uc UseCase) currentPath() string { return filepath.Join(uc.catalogDir(), "current.db") }
func (uc UseCase) metaPath() string    { return filepath.Join(uc.catalogDir(), "meta.json") }
func (uc UseCase) snapshotPath(v int64) string {
	return filepath.Join(uc.catalogDir(), fmt.Sprintf("snapshot.%d.db", v))
}

// Run downloads the newest scheme-compatible catalog. A working catalog with
// unpublished changes is replaced only with force, and is then kept beside
// the snapshot as `.before-refresh`.
func (uc UseCase) Run(ctx context.Context, force bool) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if err := os.MkdirAll(uc.catalogDir(), 0o755); err != nil {
		return Result{}, err
	}

	version, err := uc.newestCompatible(ctx)
	if err != nil {
		return Result{}, err
	}

	snapPath := uc.snapshotPath(version)
	var (
		snapHash  string
		refreshed bool
	)
	if fileExists(snapPath) {
		if snapHash, err = sha256File(snapPath); err != nil {
			return Result{}, fmt.Errorf("rehash existing snapshot: %w", err)
		}
	} else {
		if snapHash, err = uc.download(ctx, version, snapPath); err != nil {
			return Result{}, err
		}
		refreshed = true
	}

	gotScheme, err := uc.SchemeReader.ReadScheme(ctx, snapPath)
	if err != nil {
		return Result{}, fmt.Errorf("read snapshot scheme: %w", err)
	}
	if gotScheme != uc.SupportedScheme {
		return Result{}, fmt.Errorf("MCP supports scheme %d, downloaded %d; rebuild MCP",
			uc.SupportedScheme, gotScheme)
	}

	prior, hasPrior, err := uc.readMeta()
	if err != nil && !force {
		return Result{}, fmt.Errorf("%w; refusing to replace current.db without force", err)
	}
	curPath := uc.currentPath()
	switch {
	case !fileExists(curPath):
		if err := uc.Catalog.Install(ctx, snapPath, ""); err != nil {
			return Result{}, err
		}
	case hasPrior && prior.Modified && !force:
		return Result{}, errors.New("current.db has unsaved changes (meta.modified=true); publish first or use force=true")
	case hasPrior && prior.DownloadedFromVersion == version && !prior.Modified:
		// Already current: rewriting the file would only churn the log.
	default:
		backup := ""
		if force && (!hasPrior || prior.Modified) {
			backup = snapPath + ".before-refresh"
		}
		if err := uc.Catalog.Install(ctx, snapPath, backup); err != nil {
			return Result{}, err
		}
	}

	if err := uc.writeMeta(catalogMeta{
		DownloadedFromVersion: version,
		Scheme:                gotScheme,
		DownloadedAt:          uc.Clock.Now().UTC().Format(time.RFC3339),
		SnapshotSHA256:        snapHash,
	}); err != nil {
		return Result{}, err
	}
	return Result{
		Version:      version,
		Scheme:       gotScheme,
		SnapshotPath: snapPath,
		CurrentPath:  curPath,
		Refreshed:    refreshed,
	}, nil
}

// newestCompatible picks the newest version config.json advertises for the
// supported scheme.
func (uc UseCase) newestCompatible(ctx context.Context) (int64, error) {
	var cfg configManifest
	if err := uc.CDN.GetJSON(ctx, "public/config.json", &cfg); err != nil {
		return 0, fmt.Errorf("fetch config.json: %w", err)
	}
	var version int64
	for _, d := range cfg.Databases {
		if d.Scheme == uc.SupportedScheme && d.Version > version {
			version = d.Version
		}
	}
	if version == 0 {
		return 0, fmt.Errorf("no compatible database in config.json (need scheme=%d, available: %v)",
			uc.SupportedScheme, cfg.Databases)
	}
	return version, nil
}

func (uc UseCase) download(ctx context.Context, version int64, dst string) (string, error) {
	body, err := uc.CDN.GetFile(ctx, fmt.Sprintf("public/db/shruti.%d.db", version))
	if err != nil {
		return "", fmt.Errorf("fetch db: %w", err)
	}
	hash, err := atomicWriteHashed(dst, body)
	return hash, errors.Join(err, body.Close())
}

// readMeta reads meta.json; hasPrior is false when there is none yet.
func (uc UseCase) readMeta() (meta catalogMeta, hasPrior bool, err error) {
	raw, err := os.ReadFile(uc.metaPath())
	if errors.Is(err, fs.ErrNotExist) {
		return catalogMeta{}, false, nil
	}
	if err != nil {
		return catalogMeta{}, false, fmt.Errorf("read meta.json: %w", err)
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return catalogMeta{}, false, fmt.Errorf("meta.json is unreadable, so unpublished changes cannot be ruled out: %w", err)
	}
	return meta, true, nil
}

func (uc UseCase) writeMeta(meta catalogMeta) error {
	raw, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("encode meta.json: %w", err)
	}
	return os.WriteFile(uc.metaPath(), raw, 0o644)
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

// atomicWriteHashed streams src into dst through a temporary file beside it
// and returns the content's sha256.
func atomicWriteHashed(dst string, src io.Reader) (hash string, err error) {
	tmp, err := os.CreateTemp(filepath.Dir(dst), filepath.Base(dst)+".tmp-*")
	if err != nil {
		return "", err
	}
	defer func() {
		if err == nil {
			return
		}
		if cerr := tmp.Close(); cerr != nil && !errors.Is(cerr, os.ErrClosed) {
			err = errors.Join(err, cerr)
		}
		err = errors.Join(err, os.Remove(tmp.Name()))
	}()
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), src); err != nil {
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
