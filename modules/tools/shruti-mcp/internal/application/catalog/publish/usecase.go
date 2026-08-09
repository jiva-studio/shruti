// Package publish ships the freshly-built catalog DB to S3 and flips
// public/config.json so clients see the new version. Asset files under
// out/public/ and out/artifacts/ are NOT uploaded — they live in S3
// independently (audio is pushed by the pipeline, images by the content
// builder). Publish is just: new versioned .db + config pointer flip.
package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/configdoc"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type UseCase struct {
	OutDir          string
	SupportedScheme int
	Targets         []s3port.Uploader // first is primary (used for config.json read)
	OpMutex         *sync.Mutex
}

type Options struct {
	DryRun bool

	// OnProgress, if set, is called after each step (DB upload, then config
	// flip per target). FilesTotal is 1 (db) + N (targets) for the config
	// flips.
	OnProgress func(p ProgressTick)
}

// ProgressTick is the snapshot delivered to OnProgress after each step.
type ProgressTick struct {
	FilesDone     int
	FilesTotal    int
	BytesUploaded int64
}

type Result struct {
	Version    int64    `json:"version"`
	Scheme     int      `json:"scheme"`
	BytesTotal int64    `json:"bytes_uploaded"`
	Targets    []string `json:"targets"`
	DryRun     bool     `json:"dry_run,omitempty"`
	Plan       []string `json:"plan,omitempty"`
}

// configManifest models only the fields catalog.publish owns
// (`databases`, `proactive`). Other top-level keys — notably `library`
// added by library.publish — must round-trip untouched, otherwise this
// publisher silently strips them. We therefore read into a generic
// map of raw messages, peel `databases` / `proactive` out for typed
// editing, and merge the modified versions back before writing.
type databaseEntry struct {
	Version int64 `json:"version"`
	Scheme  int   `json:"scheme"`
}

type configManifest map[string]json.RawMessage

func (m configManifest) databases() []databaseEntry {
	raw, ok := m["databases"]
	if !ok {
		return nil
	}
	var out []databaseEntry
	_ = json.Unmarshal(raw, &out)
	return out
}

func (m configManifest) setDatabases(entries []databaseEntry) {
	raw, _ := json.Marshal(entries)
	m["databases"] = raw
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
		existingCfg = configManifest{}
	}
	if existingCfg == nil {
		existingCfg = configManifest{}
	}
	for _, d := range existingCfg.databases() {
		if d.Version >= cur {
			cur = d.Version + 1
		}
	}

	currentDB := filepath.Join(uc.OutDir, "artifacts", "catalog", "current.db")
	if _, err := os.Stat(currentDB); err != nil {
		return Result{}, fmt.Errorf("current.db missing — refresh first: %w", err)
	}
	// The file is about to be read as bytes, so whatever is still in the
	// write-ahead log has to be folded in first.
	if err := checkpointWAL(ctx, currentDB); err != nil {
		return Result{}, err
	}

	// Config sections (regions + proactive) live in the local config.json,
	// edited by catalog.config.regions.* / catalog.proactive.*. A full
	// publish re-ships whichever sections exist locally so config + DB stay
	// in sync; a section absent locally is left untouched on the bucket
	// (never cleared — clearing regions would strand clients).
	cfgStore := configdoc.Store{OutDir: uc.OutDir}
	managedSections := map[string]json.RawMessage{}
	for _, key := range []string{"proactive", "regions"} {
		raw, present, secErr := cfgStore.Section(key)
		if secErr != nil {
			return Result{}, secErr
		}
		if present {
			managedSections[key] = raw
		}
	}
	dbKey := fmt.Sprintf("public/db/shruti.%d.db", cur)

	plan := []string{dbKey, "public/config.json"}
	if opts.DryRun {
		return Result{
			Version: cur,
			Scheme:  uc.SupportedScheme,
			Targets: targetNames(uc.Targets),
			DryRun:  true,
			Plan:    plan,
		}, nil
	}

	totalSteps := 1 + len(uc.Targets) // 1 DB upload (broadcast to every target) + 1 config flip per target
	stepsDone := 0
	var uploadedBytes int64
	emit := func() {
		if opts.OnProgress == nil {
			return
		}
		opts.OnProgress(ProgressTick{
			FilesDone:     stepsDone,
			FilesTotal:    totalSteps,
			BytesUploaded: uploadedBytes,
		})
	}

	// 2. Upload the new versioned DB to every target. Held back from config
	// flip so a partial failure here leaves the previous version still live
	// on every target.
	dbBody, dbSize, err := readFileSized(currentDB)
	if err != nil {
		return Result{}, err
	}
	for _, target := range uc.Targets {
		if err := target.Put(ctx, dbKey, "application/x-sqlite3", bytes.NewReader(dbBody), dbSize); err != nil {
			return Result{}, fmt.Errorf("put %s (%s): %w", dbKey, target.Name(), err)
		}
		uploadedBytes += dbSize
	}
	stepsDone++
	emit()

	// 3. Flip config.json on each target. If a Put here fails on target N,
	// every target ≤ N has the new version live; targets > N still serve
	// the previous version. Best we can do without a cross-target txn —
	// but no client ever sees a config pointing at a missing .db.
	for _, target := range uc.Targets {
		var cfg configManifest
		if _, err := target.GetJSON(ctx, "public/config.json", &cfg); err != nil {
			return Result{}, fmt.Errorf("get config.json (%s): %w", target.Name(), err)
		}
		if cfg == nil {
			cfg = configManifest{}
		}
		// dedupe by version, prepend, sort desc. We keep EVERY previously
		// published version: a client pinned to an older scheme must keep
		// finding its compatible DB. Dropping old entries here strands those
		// clients ("No compatible content database for scheme N") even though
		// the .db blob is still on the bucket. Old blobs are pruned (if ever)
		// by a separate, scheme-aware retention pass, never by a blind top-N.
		entries := cfg.databases()
		filtered := entries[:0]
		for _, d := range entries {
			if d.Version != cur {
				filtered = append(filtered, d)
			}
		}
		filtered = append([]databaseEntry{{Version: cur, Scheme: uc.SupportedScheme}}, filtered...)
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Version > filtered[j].Version })
		cfg.setDatabases(filtered)
		// Re-ship the locally-edited config sections (regions + proactive)
		// from config.json — the local file is the source of truth. Sections
		// absent locally are left as-is on the bucket. Other top-level keys
		// (e.g. `library` written by library.publish) stay untouched because
		// we never touch them.
		for key, raw := range managedSections {
			cfg[key] = raw
		}
		body, _ := json.MarshalIndent(cfg, "", "  ")
		if err := target.Put(ctx, "public/config.json", "application/json", bytes.NewReader(body), int64(len(body))); err != nil {
			return Result{}, fmt.Errorf("put config.json (%s): %w", target.Name(), err)
		}
		uploadedBytes += int64(len(body))
		stepsDone++
		emit()
	}

	// 4. Update meta.json: published_version + reset modified=false. Only
	// after every target accepted the config.json flip — otherwise the
	// local record could lie about what the remote serves.
	if err := updateMetaPublished(uc.OutDir, cur); err != nil {
		return Result{}, err
	}

	return Result{
		Version:    cur,
		Scheme:     uc.SupportedScheme,
		BytesTotal: uploadedBytes,
		Targets:    targetNames(uc.Targets),
	}, nil
}

func readFileSized(path string) ([]byte, int64, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	return body, int64(len(body)), nil
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
