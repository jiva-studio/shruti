// Bunny-CDN self-bootstrap for the two SQLite artifacts — a direct port of
// chat's indexer (catalog.py / library/db.py / s3.py):
//
//   - read the manifest ${MEDIA_BASE_URL}/public/config.json
//   - pick the latest catalog version  (databases[] -> public/db/lectorium.{v}.db)
//     and the latest library version   (library.versions[] -> public/library/library.{v}.db)
//   - stream-download, verify the SQLite header, atomic os.Rename swap into place
//   - refresh on boot and on a periodic ticker; each swap is picked up by
//     reopening the sqlitedb.Handle.
package sqlitedb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// sqliteMagic is the fixed 16-byte header of every SQLite database file.
const sqliteMagic = "SQLite format 3\x00"

type manifest struct {
	Databases []struct {
		Version json.Number `json:"version"`
	} `json:"databases"`
	Library struct {
		Versions []struct {
			Version json.Number `json:"version"`
		} `json:"versions"`
	} `json:"library"`
}

// Bootstrap fetches + swaps the library/catalog SQLite artifacts.
type Bootstrap struct {
	mediaBase  string
	libPath    string
	catPath    string
	libHandle  *Handle
	catHandle  *Handle
	http       *http.Client
	libVersion string
	catVersion string
}

// NewBootstrap wires the downloader to the two on-disk targets and their live
// handles.
func NewBootstrap(mediaBase, libPath, catPath string, libHandle, catHandle *Handle) *Bootstrap {
	return &Bootstrap{
		mediaBase: trimSlash(mediaBase),
		libPath:   libPath,
		catPath:   catPath,
		libHandle: libHandle,
		catHandle: catHandle,
		http:      &http.Client{Timeout: 5 * time.Minute},
		// Seed the in-memory versions from sidecar files written on the last
		// download, so a restart that keeps the on-disk artifacts (volume) knows
		// their real version — otherwise RefreshOnce would treat any present file
		// as version "" and either needlessly re-download or, worse, never notice
		// a newer published version until the ticker's first tick.
		libVersion: readVersionSidecar(libPath),
		catVersion: readVersionSidecar(catPath),
	}
}

// versionSidecar is the tiny companion file next to a DB recording the version
// currently on disk (e.g. library.db.version).
func versionSidecar(dbPath string) string { return dbPath + ".version" }

func readVersionSidecar(dbPath string) string {
	data, err := os.ReadFile(versionSidecar(dbPath))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// writeVersionSidecar records the on-disk version. Best-effort: a write failure
// only costs a redundant re-download on the next start, never correctness.
func writeVersionSidecar(dbPath, version string) {
	if err := os.WriteFile(versionSidecar(dbPath), []byte(version), 0o644); err != nil {
		log.Printf("bootstrap: write version sidecar %s: %v", versionSidecar(dbPath), err)
	}
}

// SetHandles attaches the live handles used by periodic swaps. Call after the
// on-disk files exist (post EnsureBoot) and the handles are opened.
func (b *Bootstrap) SetHandles(libHandle, catHandle *Handle) {
	b.libHandle = libHandle
	b.catHandle = catHandle
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

// RefreshOnce checks the manifest and swaps any artifact whose latest
// published version is newer than what is on disk. Returns nil if nothing
// changed. A missing `library` field is non-fatal (older publishers).
func (b *Bootstrap) RefreshOnce(ctx context.Context) error {
	m, err := b.readManifest(ctx)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}

	catLatest := latest(versionsOf(m.Databases))
	if catLatest != "" && catLatest != b.catVersion {
		if err := b.swap(ctx,
			fmt.Sprintf("%s/public/db/lectorium.%s.db", b.mediaBase, catLatest),
			b.catPath, b.catHandle); err != nil {
			return fmt.Errorf("catalog swap: %w", err)
		}
		log.Printf("bootstrap: catalog swapped %s -> %s", b.catVersion, catLatest)
		b.catVersion = catLatest
		writeVersionSidecar(b.catPath, catLatest)
	}

	libLatest := latest(libVersionsOf(m))
	if libLatest != "" && libLatest != b.libVersion {
		if err := b.swap(ctx,
			fmt.Sprintf("%s/public/library/library.%s.db", b.mediaBase, libLatest),
			b.libPath, b.libHandle); err != nil {
			return fmt.Errorf("library swap: %w", err)
		}
		log.Printf("bootstrap: library swapped %s -> %s", b.libVersion, libLatest)
		b.libVersion = libLatest
		writeVersionSidecar(b.libPath, libLatest)
	}
	return nil
}

// EnsureBoot downloads both artifacts if they are missing on disk, so the
// service can start even with an empty CATALOG_DIR. Handles are (re)opened by
// the caller after this returns.
func (b *Bootstrap) EnsureBoot(ctx context.Context) error {
	m, err := b.readManifest(ctx)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	catLatest := latest(versionsOf(m.Databases))
	if catLatest == "" {
		return fmt.Errorf("manifest has no catalog databases")
	}
	if err := b.download(ctx,
		fmt.Sprintf("%s/public/db/lectorium.%s.db", b.mediaBase, catLatest), b.catPath); err != nil {
		return err
	}
	b.catVersion = catLatest
	writeVersionSidecar(b.catPath, catLatest)

	libLatest := latest(libVersionsOf(m))
	if libLatest != "" {
		if err := b.download(ctx,
			fmt.Sprintf("%s/public/library/library.%s.db", b.mediaBase, libLatest), b.libPath); err != nil {
			return err
		}
		b.libVersion = libLatest
		writeVersionSidecar(b.libPath, libLatest)
	}
	return nil
}

// Run refreshes on the given interval until ctx is cancelled.
func (b *Bootstrap) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := b.RefreshOnce(ctx); err != nil {
				log.Printf("bootstrap: refresh error: %v", err)
			}
		}
	}
}

func (b *Bootstrap) readManifest(ctx context.Context) (*manifest, error) {
	url := b.mediaBase + "/public/config.json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := b.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("config.json: HTTP %d", resp.StatusCode)
	}
	var m manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

// swap downloads url to a temp file next to dest, verifies it, atomically
// renames it over dest, then reopens the handle so readers see the new inode.
func (b *Bootstrap) swap(ctx context.Context, url, dest string, h *Handle) error {
	if err := b.download(ctx, url, dest); err != nil {
		return err
	}
	return h.Reopen()
}

// download streams url into a temp file on dest's filesystem, verifies the
// SQLite header, then os.Rename-swaps it into place (atomic on the same fs).
func (b *Bootstrap) download(ctx context.Context, url, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".tmp"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := b.http.Do(req)
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

// verifySQLite checks the 16-byte magic header of a downloaded file.
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

func versionsOf(dbs []struct {
	Version json.Number `json:"version"`
}) []string {
	out := make([]string, 0, len(dbs))
	for _, d := range dbs {
		if s := d.Version.String(); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func libVersionsOf(m *manifest) []string {
	out := make([]string, 0, len(m.Library.Versions))
	for _, v := range m.Library.Versions {
		if s := v.Version.String(); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// latest returns the numerically-greatest version string (versions are
// monotonic timestamp integers like 20260519144040).
func latest(vs []string) string {
	best := ""
	var bestN int64 = -1
	for _, v := range vs {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			// Non-numeric: fall back to lexical max.
			if v > best {
				best = v
			}
			continue
		}
		if n > bestN {
			bestN = n
			best = v
		}
	}
	return best
}
