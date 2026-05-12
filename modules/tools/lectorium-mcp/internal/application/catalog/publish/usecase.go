// Package publish copies the local out/ tree into S3, bumps the catalog
// version, and merges public/config.json. Mirrors content-db-builder's
// upload.ts logic 1-for-1.
package publish

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	s3port "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

type UseCase struct {
	OutDir          string
	SupportedScheme int
	Targets         []s3port.Uploader // first is primary (used for config.json read)
	OpMutex         *sync.Mutex
}

type Options struct {
	DryRun bool

	// ForceFull disables incremental skipping: every file is re-uploaded even
	// if the S3 object exists with matching size. Use after content
	// migrations (e.g. re-encoded MP3 with same byte count, edited title)
	// where the size-equality heuristic isn't enough.
	ForceFull bool

	// VerifyChecksum upgrades the size-only skip heuristic to a content
	// hash check: when the remote ETag matches the local file's MD5, skip;
	// otherwise re-upload. Multipart-uploaded objects (ETag has '-N'
	// suffix) can't be verified this way and are always re-uploaded under
	// this flag. Costs an extra disk read per skipped file, so off by
	// default — turn on when a known content drift makes size alone
	// untrustworthy (e.g. re-encoded mp3 happened to land on the same byte
	// count after a tag edit).
	VerifyChecksum bool

	// OnProgress, if set, is called after each step (upload or skip) across
	// all targets. The runner pushes these into Run.Progress; the daemon
	// log also emits a heartbeat line every ~10 files.
	OnProgress func(p ProgressTick)
}

// ProgressTick is the snapshot delivered to OnProgress after each step.
// FilesDone counts every step (uploaded + skipped) so a progress bar shows
// "I/N processed". The Uploaded vs Skipped split lets the caller render
// "skipped" cleanly when the incremental run finds nothing to push.
type ProgressTick struct {
	FilesDone     int
	FilesTotal    int
	FilesUploaded int
	FilesSkipped  int
	BytesUploaded int64
	BytesSkipped  int64
}

type Result struct {
	Version      int64    `json:"version"`
	Scheme       int      `json:"scheme"`
	Files        int      `json:"files_uploaded"`
	FilesSkipped int      `json:"files_skipped"`
	BytesTotal   int64    `json:"bytes_uploaded"`
	BytesSkipped int64    `json:"bytes_skipped"`
	Targets      []string `json:"targets"`
	DryRun       bool     `json:"dry_run,omitempty"`
	Plan         []string `json:"plan,omitempty"`
}

type configManifest struct {
	Databases []struct {
		Version int64 `json:"version"`
		Scheme  int   `json:"scheme"`
	} `json:"databases"`
}

func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if len(uc.Targets) == 0 {
		return Result{}, fmt.Errorf("no S3 targets configured")
	}
	primary := uc.Targets[0]

	// 1. Bump version (collision-protect against config.json existing entries).
	now := time.Now().UTC().Format("20060102150405")
	cur, err := versionFromString(now)
	if err != nil {
		return Result{}, err
	}
	var existingCfg configManifest
	if found, err := primary.GetJSON(ctx, "public/config.json", &existingCfg); err != nil {
		return Result{}, fmt.Errorf("get config.json: %w", err)
	} else if !found {
		// brand-new bucket; OK, treat as empty.
	}
	for _, d := range existingCfg.Databases {
		if d.Version >= cur {
			cur = d.Version + 1
		}
	}

	// 2. Copy current.db → public/db/lectorium.{cur}.db (atomic).
	currentDB := filepath.Join(uc.OutDir, "artifacts", "catalog", "current.db")
	if _, err := os.Stat(currentDB); err != nil {
		return Result{}, fmt.Errorf("current.db missing — refresh first: %w", err)
	}
	publishedDB := filepath.Join(uc.OutDir, "public", "db", fmt.Sprintf("lectorium.%d.db", cur))
	if err := copyFile(currentDB, publishedDB); err != nil {
		return Result{}, err
	}

	// 3. Walk out/ — collect every file under public/ and artifacts/, skipping
	// runtime-only artefacts (SQLite WAL companions, ad-hoc backups) that
	// would otherwise leak local state into S3.
	var files []string
	for _, sub := range []string{"public", "artifacts"} {
		root := filepath.Join(uc.OutDir, sub)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if shouldSkip(uc.OutDir, p) {
				return nil
			}
			files = append(files, p)
			return nil
		})
		if err != nil {
			return Result{}, fmt.Errorf("walk %s: %w", root, err)
		}
	}
	sort.Strings(files)

	plan := make([]string, 0, len(files)+1)
	for _, f := range files {
		key := keyFor(uc.OutDir, f)
		plan = append(plan, key)
	}
	plan = append(plan, "public/config.json")

	if opts.DryRun {
		return Result{
			Version: cur,
			Scheme:  uc.SupportedScheme,
			Targets: targetNames(uc.Targets),
			Files:   len(files),
			DryRun:  true,
			Plan:    plan,
		}, nil
	}

	// 4. PUT every file to every target. Incremental by default: if the
	// remote object exists with a matching size we skip it (pipeline outputs
	// are deterministic per (track_id, stage) so size-equality is a strong
	// proxy for content-equality). ForceFull bypasses the skip.
	var uploadedBytes int64
	var skippedFiles int
	var skippedBytes int64
	uploadedFiles := 0
	totalSteps := len(files) * len(uc.Targets)
	stepsDone := 0
	emit := func() {
		if opts.OnProgress == nil {
			return
		}
		opts.OnProgress(ProgressTick{
			FilesDone:     stepsDone,
			FilesTotal:    totalSteps,
			FilesUploaded: uploadedFiles,
			FilesSkipped:  skippedFiles,
			BytesUploaded: uploadedBytes,
			BytesSkipped:  skippedBytes,
		})
	}
	// Phase 4a: upload every file to every target. config.json is held
	// back so a partial failure on one target leaves the whole publish
	// rewindable — old config.json on every target still points at the
	// previous version and clients keep using it.
	for _, target := range uc.Targets {
		for _, f := range files {
			key := keyFor(uc.OutDir, f)
			localSize, err := fileSize(f)
			if err != nil {
				return Result{}, err
			}
			if !opts.ForceFull {
				remoteSize, remoteETag, exists, err := target.Head(ctx, key)
				if err != nil {
					return Result{}, fmt.Errorf("head %s: %w", key, err)
				}
				if exists && remoteSize == localSize {
					skip := true
					if opts.VerifyChecksum {
						// Hyphen → multipart upload, no plain MD5 in ETag
						// → can't verify, re-upload to be safe.
						if remoteETag == "" || strings.Contains(remoteETag, "-") {
							skip = false
						} else {
							localMD5, herr := fileMD5Hex(f)
							if herr != nil {
								return Result{}, fmt.Errorf("md5 %s: %w", f, herr)
							}
							skip = localMD5 == remoteETag
						}
					}
					if skip {
						skippedFiles++
						skippedBytes += localSize
						stepsDone++
						emit()
						continue
					}
				}
			}
			body, sz, err := readFileSized(f)
			if err != nil {
				return Result{}, err
			}
			ct := contentTypeFor(f)
			if err := target.Put(ctx, key, ct, bytes.NewReader(body), sz); err != nil {
				return Result{}, fmt.Errorf("put %s: %w", key, err)
			}
			uploadedBytes += sz
			uploadedFiles++
			stepsDone++
			emit()
		}
	}

	// Phase 4b: now that every target has the new file payload, flip
	// config.json on each target. If a Put here fails on target N, every
	// target ≤ N has the new version live; targets > N still serve the
	// previous version. That's the best we can do without a cross-target
	// transaction — but at least no client ever sees a config that
	// references files that aren't there yet.
	for _, target := range uc.Targets {
		var cfg configManifest
		if _, err := target.GetJSON(ctx, "public/config.json", &cfg); err != nil {
			return Result{}, fmt.Errorf("get config.json (%s): %w", target.Name(), err)
		}
		// dedupe by version, prepend, sort desc, top 5.
		filtered := cfg.Databases[:0]
		for _, d := range cfg.Databases {
			if d.Version != cur {
				filtered = append(filtered, d)
			}
		}
		filtered = append([]struct {
			Version int64 `json:"version"`
			Scheme  int   `json:"scheme"`
		}{{Version: cur, Scheme: uc.SupportedScheme}}, filtered...)
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Version > filtered[j].Version })
		if len(filtered) > 5 {
			filtered = filtered[:5]
		}
		cfg.Databases = filtered
		body, _ := json.MarshalIndent(cfg, "", "  ")
		if err := target.Put(ctx, "public/config.json", "application/json", bytes.NewReader(body), int64(len(body))); err != nil {
			return Result{}, fmt.Errorf("put config.json (%s): %w", target.Name(), err)
		}
	}

	// 6. Update meta.json: published_version + reset modified=false.
	// Only after every target accepted the config.json flip — otherwise
	// the local "we published version X" record could lie about what
	// the remote actually serves.
	if err := updateMetaPublished(uc.OutDir, cur); err != nil {
		return Result{}, err
	}

	return Result{
		Version:      cur,
		Scheme:       uc.SupportedScheme,
		Files:        uploadedFiles,
		FilesSkipped: skippedFiles,
		BytesTotal:   uploadedBytes,
		BytesSkipped: skippedBytes,
		Targets:      targetNames(uc.Targets),
	}, nil
}

func keyFor(outDir, full string) string {
	rel, _ := filepath.Rel(outDir, full)
	return filepath.ToSlash(rel)
}

// shouldSkip returns true for files that exist on disk but must NOT be
// published to S3:
//   - SQLite WAL companion files (-shm/-wal) — live runtime state, not a
//     consistent snapshot. SQLite checkpoints them into the main .db on
//     normal close; if we ever ship them, downstream readers see a half-
//     applied transaction.
//   - Per-process *.bak-<timestamp> files — local backups created by
//     upgrade/migration code paths, irrelevant to consumers.
func shouldSkip(outDir, full string) bool {
	rel, err := filepath.Rel(outDir, full)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)
	base := filepath.Base(rel)
	if strings.HasSuffix(base, ".db-shm") || strings.HasSuffix(base, ".db-wal") {
		return true
	}
	if strings.Contains(base, ".bak-") {
		return true
	}
	return false
}

func contentTypeFor(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".db":
		return "application/x-sqlite3"
	case ".json":
		return "application/json"
	case ".mp3":
		return "audio/mpeg"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".svg":
		return "image/svg+xml"
	}
	return "application/octet-stream"
}

func readFileSized(path string) ([]byte, int64, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	return body, int64(len(body)), nil
}

func fileSize(path string) (int64, error) {
	st, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// fileMD5Hex returns the lowercase hex MD5 of the file at path. Used by
// VerifyChecksum mode to compare against an S3 single-part ETag.
func fileMD5Hex(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
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

func versionFromString(s string) (int64, error) {
	var v int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid version digit %q", c)
		}
		v = v*10 + int64(c-'0')
	}
	return v, nil
}

func targetNames(ts []s3port.Uploader) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = fmt.Sprintf("%s/%s", t.Name(), t.Bucket())
	}
	return out
}

func updateMetaPublished(outDir string, version int64) error {
	metaPath := filepath.Join(outDir, "artifacts", "catalog", "meta.json")
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return err
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return err
	}
	data["published_version"] = version
	data["published_at"] = time.Now().UTC().Format(time.RFC3339)
	data["modified"] = false
	out, _ := json.MarshalIndent(data, "", "  ")
	return os.WriteFile(metaPath, out, 0o644)
}

// avoid unused import in some configurations
var _ = catalog.SupportedDBScheme
