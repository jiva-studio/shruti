// Package librarypublish ships the canonical-corpus DB
// (artifacts/library/library.db) to S3 under
// public/library/library.{version}.db and adds the new version to
// public/config.json under a `library` field, separately from the track
// catalog's own version ladder.
//
// Library and catalog publish independently because their change cadences
// differ: catalog moves on every new lecture / metadata fix; library moves
// only when the underlying corpus changes (a new RU translation source, a
// re-import, etc.).
package librarypublish

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

	s3port "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type UseCase struct {
	OutDir  string
	Targets []s3port.Uploader // first is primary (used for config.json read)
	OpMutex *sync.Mutex
}

type Options struct {
	DryRun     bool
	OnProgress func(p ProgressTick)
}

type ProgressTick struct {
	FilesDone     int
	FilesTotal    int
	BytesUploaded int64
}

type Result struct {
	Version    int64    `json:"version"`
	BytesTotal int64    `json:"bytes_uploaded"`
	Targets    []string `json:"targets"`
	DryRun     bool     `json:"dry_run,omitempty"`
	Plan       []string `json:"plan,omitempty"`
}

// configManifest is the partial view we read/write for library entries.
// We deliberately use map[string]json.RawMessage for the unknown top-level
// keys so we don't clobber `databases` / `proactive` written by the
// catalog publisher.
type configManifest map[string]json.RawMessage

type libraryEntry struct {
	Version int64 `json:"version"`
}

type librarySection struct {
	Versions []libraryEntry `json:"versions"`
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

	// Read existing config to compute a fresh non-colliding version.
	now := time.Now().UTC().Format("20060102150405")
	cur, err := versionFromString(now)
	if err != nil {
		return Result{}, err
	}
	var cfg configManifest
	if found, err := primary.GetJSON(ctx, "public/config.json", &cfg); err != nil {
		return Result{}, fmt.Errorf("get config.json: %w", err)
	} else if !found {
		cfg = configManifest{}
	}
	if libRaw, ok := cfg["library"]; ok {
		var lib librarySection
		if err := json.Unmarshal(libRaw, &lib); err == nil {
			for _, e := range lib.Versions {
				if e.Version >= cur {
					cur = e.Version + 1
				}
			}
		}
	}

	libraryDB := filepath.Join(uc.OutDir, "artifacts", "library", "library.db")
	if _, err := os.Stat(libraryDB); err != nil {
		return Result{}, fmt.Errorf("library.db missing — import it first via agent/library_import/import.py: %w", err)
	}
	dbKey := fmt.Sprintf("public/library/library.%d.db", cur)
	plan := []string{dbKey, "public/config.json"}

	if opts.DryRun {
		return Result{
			Version: cur,
			Targets: targetNames(uc.Targets),
			DryRun:  true,
			Plan:    plan,
		}, nil
	}

	totalSteps := 1 + len(uc.Targets)
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

	dbBody, dbSize, err := readFileSized(libraryDB)
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

	for _, target := range uc.Targets {
		var existing configManifest
		if _, err := target.GetJSON(ctx, "public/config.json", &existing); err != nil {
			return Result{}, fmt.Errorf("get config.json (%s): %w", target.Name(), err)
		}
		if existing == nil {
			existing = configManifest{}
		}
		// Merge the library section: dedup by version, prepend, sort desc. We
		// keep EVERY previously published version — a client pinned to an
		// older library scheme must keep finding its compatible version.
		// Dropping old entries here strands those clients even though the blob
		// is still on the bucket. Old blobs are pruned (if ever) by a separate,
		// scheme-aware retention pass, never by a blind top-N.
		var lib librarySection
		if raw, ok := existing["library"]; ok {
			_ = json.Unmarshal(raw, &lib)
		}
		filtered := lib.Versions[:0]
		for _, e := range lib.Versions {
			if e.Version != cur {
				filtered = append(filtered, e)
			}
		}
		filtered = append([]libraryEntry{{Version: cur}}, filtered...)
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Version > filtered[j].Version })
		lib.Versions = filtered
		libRaw, _ := json.Marshal(lib)
		existing["library"] = libRaw
		body, _ := json.MarshalIndent(existing, "", "  ")
		if err := target.Put(ctx, "public/config.json", "application/json", bytes.NewReader(body), int64(len(body))); err != nil {
			return Result{}, fmt.Errorf("put config.json (%s): %w", target.Name(), err)
		}
		uploadedBytes += int64(len(body))
		stepsDone++
		emit()
	}

	return Result{
		Version:    cur,
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
