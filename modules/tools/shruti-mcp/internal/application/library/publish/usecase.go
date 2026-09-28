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
	"errors"
	"fmt"
	"sort"
	"sync"

	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// Library hands over library.db as it would be uploaded: one committed state,
// write-ahead log included.
type Library interface {
	Snapshot(ctx context.Context) ([]byte, error)
}

type UseCase struct {
	Library Library
	Targets []s3port.Uploader // first is primary (used for config.json read)
	OpMutex *sync.Mutex
	Clock   clockport.Clock
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

// configManifest keeps every top-level key as raw JSON, so `databases`,
// `proactive` and `regions`, which other publishers own, round-trip untouched.
type configManifest map[string]json.RawMessage

type libraryEntry struct {
	Version int64 `json:"version"`
}

type librarySection struct {
	Versions []libraryEntry `json:"versions"`
}

// library decodes the published versions list. A list that does not decode
// is an error: rewriting config.json over it would drop every version it held
// and strand the readers pinned to them.
func (m configManifest) library() (librarySection, error) {
	var lib librarySection
	raw, ok := m["library"]
	if !ok {
		return lib, nil
	}
	if err := json.Unmarshal(raw, &lib); err != nil {
		return lib, fmt.Errorf("config.json library section is unreadable, refusing to publish over it: %w", err)
	}
	return lib, nil
}

func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if len(uc.Targets) == 0 {
		return Result{}, errors.New("no S3 targets configured")
	}
	primary := uc.Targets[0]

	// A fresh version, above every one already published.
	cur, err := versionFromString(uc.Clock.Now().UTC().Format("20060102150405"))
	if err != nil {
		return Result{}, err
	}
	var cfg configManifest
	if _, err := primary.GetJSON(ctx, "public/config.json", &cfg); err != nil {
		return Result{}, fmt.Errorf("get config.json: %w", err)
	}
	lib, err := cfg.library()
	if err != nil {
		return Result{}, err
	}
	for _, e := range lib.Versions {
		if e.Version >= cur {
			cur = e.Version + 1
		}
	}

	dbBody, err := uc.Library.Snapshot(ctx)
	if err != nil {
		return Result{}, err
	}
	dbKey := fmt.Sprintf("public/library/library.%d.db", cur)
	if opts.DryRun {
		return Result{
			Version: cur,
			Targets: targetNames(uc.Targets),
			DryRun:  true,
			Plan:    []string{dbKey, "public/config.json"},
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

	dbSize := int64(len(dbBody))
	for _, target := range uc.Targets {
		if err := target.Put(ctx, dbKey, "application/x-sqlite3", bytes.NewReader(dbBody), dbSize); err != nil {
			return Result{}, fmt.Errorf("put %s (%s): %w", dbKey, target.Name(), err)
		}
		uploadedBytes += dbSize
	}
	stepsDone++
	emit()

	for _, target := range uc.Targets {
		body, err := uc.withVersion(ctx, target, cur)
		if err != nil {
			return Result{}, err
		}
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

// withVersion returns the target's config.json with version added to the
// library section. Every published version is kept, newest first: a reader
// pinned to an older version must keep finding it while its blob is on the
// bucket; pruning old blobs is a separate, scheme-aware decision.
func (uc UseCase) withVersion(ctx context.Context, target s3port.Uploader, version int64) ([]byte, error) {
	var cfg configManifest
	if _, err := target.GetJSON(ctx, "public/config.json", &cfg); err != nil {
		return nil, fmt.Errorf("get config.json (%s): %w", target.Name(), err)
	}
	if cfg == nil {
		cfg = configManifest{}
	}
	lib, err := cfg.library()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", target.Name(), err)
	}
	versions := []libraryEntry{{Version: version}}
	for _, e := range lib.Versions {
		if e.Version != version {
			versions = append(versions, e)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i].Version > versions[j].Version })
	lib.Versions = versions
	libRaw, err := json.Marshal(lib)
	if err != nil {
		return nil, fmt.Errorf("encode library section: %w", err)
	}
	cfg["library"] = libRaw
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode config.json: %w", err)
	}
	return body, nil
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
