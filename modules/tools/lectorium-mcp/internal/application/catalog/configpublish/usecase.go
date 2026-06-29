// Package configpublish pushes the human-edited config sections (`regions`,
// `proactive`) from the local config.json (package configdoc) into the
// published public/config.json on every S3 target — WITHOUT touching the
// database or its version ladder.
//
// This is the "config only" publish: changing a server / IP or a proactive
// rule goes live for clients without re-uploading the catalog DB or bumping a
// version. The `databases` (and `library`) keys on S3 are owned by
// catalog.publish / library.publish and are preserved untouched here.
package configpublish

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/configdoc"
	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

const configKey = "public/config.json"

// sections copied from the local config doc into the published config.json.
// Order is irrelevant; keep in sync with what the CRUD tools edit.
var managedSections = []string{"regions", "proactive"}

type UseCase struct {
	OutDir  string
	Targets []s3port.Uploader
	OpMutex *sync.Mutex
}

type Options struct {
	DryRun bool
}

type Result struct {
	Sections   []string `json:"sections"`
	BytesTotal int64    `json:"bytes_uploaded"`
	Targets    []string `json:"targets"`
	DryRun     bool     `json:"dry_run,omitempty"`
}

type configManifest map[string]json.RawMessage

// Run merges the local config sections into each target's config.json.
func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	if uc.OpMutex != nil {
		uc.OpMutex.Lock()
		defer uc.OpMutex.Unlock()
	}
	if len(uc.Targets) == 0 {
		return Result{}, fmt.Errorf("no S3 targets configured")
	}

	store := configdoc.Store{OutDir: uc.OutDir, Mu: uc.OpMutex}
	local, found, err := store.Load()
	if err != nil {
		return Result{}, err
	}
	if !found {
		return Result{}, fmt.Errorf("local config.json missing (%s) — edit regions/proactive first", store.Path())
	}

	// Collect the sections present locally as raw JSON.
	present := map[string]json.RawMessage{}
	for _, key := range managedSections {
		if v, ok := local[key]; ok {
			b, mErr := json.Marshal(v)
			if mErr != nil {
				return Result{}, fmt.Errorf("marshal %s: %w", key, mErr)
			}
			present[key] = b
		}
	}
	sectionNames := make([]string, 0, len(present))
	for _, key := range managedSections {
		if _, ok := present[key]; ok {
			sectionNames = append(sectionNames, key)
		}
	}

	if opts.DryRun {
		return Result{
			Sections: sectionNames,
			Targets:  targetNames(uc.Targets),
			DryRun:   true,
		}, nil
	}

	var uploaded int64
	for _, target := range uc.Targets {
		var cfg configManifest
		if _, err := target.GetJSON(ctx, configKey, &cfg); err != nil {
			return Result{}, fmt.Errorf("get config.json (%s): %w", target.Name(), err)
		}
		if cfg == nil {
			cfg = configManifest{}
		}
		// Overwrite only the managed sections; databases / library and any
		// other keys round-trip untouched.
		for key, raw := range present {
			cfg[key] = raw
		}
		body, _ := json.MarshalIndent(cfg, "", "  ")
		if err := target.Put(ctx, configKey, "application/json", bytes.NewReader(body), int64(len(body))); err != nil {
			return Result{}, fmt.Errorf("put config.json (%s): %w", target.Name(), err)
		}
		uploaded += int64(len(body))
	}

	return Result{
		Sections:   sectionNames,
		BytesTotal: uploaded,
		Targets:    targetNames(uc.Targets),
	}, nil
}

func targetNames(ts []s3port.Uploader) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = fmt.Sprintf("%s/%s", t.Name(), t.Bucket())
	}
	return out
}
