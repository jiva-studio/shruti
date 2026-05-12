package ingest

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/stagefail"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	audioport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/audio"
	commitport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/commit"
	fsport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/fs"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/hashing"
	lakeport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
)

// ErrSkipExtra means the path lives under outbox/sorted/<lang>/extra/...
// (bhajans, kirtans, walks, lecture fragments, etc.) — content we
// deliberately don't ingest. Callers should treat this as a benign skip,
// not a failure.
var ErrSkipExtra = errors.New("ingest: skipped — path is under outbox/sorted/<lang>/extra/")

type UseCase struct {
	Registry   lakeport.Registry
	Audio      audioport.Store
	FS         fsport.Stat
	Hasher     hashing.Hasher
	Rollbacker commitport.Rollbacker // optional; nil disables cascade rollback (callers using ingest in isolation can omit it)
}

type Result struct {
	TrackId       track.Id
	SHA256Changed bool
}

// extraPathRE matches paths under the dedup-tool's "extra" buckets — see
// resources/lake-in/dedup.py and the canonical parser regex (parser.go).
var extraPathRE = regexp.MustCompile(`(?:^|/)outbox/sorted/(?:ru|en)/extra/`)

// langPathRE captures the language code from the dedup-tool's canonical
// layout: outbox/sorted/<lang>/<bucket>/<filename>. Returns "" if the
// path doesn't match (test fixtures, ad-hoc ingests).
var langPathRE = regexp.MustCompile(`(?:^|/)outbox/sorted/(ru|en)/`)

func languageFromPath(p string) string {
	m := langPathRE.FindStringSubmatch(p)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// Run canonicalizes the path, computes SHA256, mints/looks up trackId,
// MOVES the source mp3 into out/artifacts/tracks/{id}/audio/source.mp3,
// and marks stage Ingested=Done. If sha256 changed for an existing path,
// any committed catalog rows for that track are rolled back first and all
// later stages cascade to pending.
//
// The artifact replaces the input on disk (rename if same FS, copy+remove
// otherwise) — so a 200 GB lake doesn't double during ingest. Re-ingesting
// the same path after the source has already moved is idempotent: if the
// registry knows the path and the artifact is on disk, we short-circuit.
//
// Paths under outbox/sorted/<lang>/extra/ are intentionally skipped via
// ErrSkipExtra.
func (uc UseCase) Run(ctx context.Context, path string) (res Result, rerr error) {
	abs, err := canonicalPath(path)
	if err != nil {
		return Result{}, err
	}

	if extraPathRE.MatchString(abs) {
		return Result{}, ErrSkipExtra
	}

	// Idempotent short-circuit: if we already ingested this path and the
	// artifact is still on disk, the source file is gone (we moved it).
	// Stat'ing the input would fail; bypass that check.
	if id, ok, err := uc.Registry.LookupByPath(ctx, abs); err == nil && ok {
		stage, has, err := uc.Registry.GetStage(ctx, id, pipeline.Key{Stage: pipeline.StageIngested})
		if err == nil && has && stage.Status == pipeline.StatusDone {
			if _, err := os.Stat(uc.Audio.SourceArtifactPath(id)); err == nil {
				return Result{TrackId: id}, nil
			}
		}
	}

	stat, exists, err := uc.FS.Stat(ctx, abs)
	if err != nil {
		return Result{}, fmt.Errorf("stat %s: %w", abs, err)
	}
	if !exists {
		return Result{}, fmt.Errorf("ingest: %s does not exist", abs)
	}
	sum, err := uc.Hasher.HashFile(ctx, abs)
	if err != nil {
		return Result{}, err
	}

	src := track.SourceFile{
		Path:         abs,
		SHA256:       sum,
		Size:         stat.SizeBytes,
		Language:     languageFromPath(abs),
		DiscoveredAt: time.Now().UTC(),
	}
	id, changed, err := uc.Registry.UpsertFile(ctx, src)
	if err != nil {
		return Result{}, err
	}

	// Claim the ingest stage AFTER UpsertFile so the trackId is known. This
	// serializes concurrent pipeline_run on the same path: the second caller
	// sees claimed=false and gets a clean "another worker holds stage" error
	// instead of racing on the artifact copy + cascade reset below.
	stageKey := pipeline.Key{Stage: pipeline.StageIngested}
	claimed, err := uc.Registry.TryClaimStage(ctx, id, stageKey)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		return Result{}, fmt.Errorf("ingest: another worker holds stage for %s", id)
	}
	defer stagefail.MarkOnExit(uc.Registry, id, stageKey, ctx, &rerr)

	if changed {
		// Source content changed under us — purge any prior catalog commit
		// for this track BEFORE the registry cascades commit→pending; if we
		// reset first, the catalog row is orphaned and the next commit
		// either UPSERT-overwrites it silently or hits a constraint.
		if uc.Rollbacker != nil {
			if err := uc.Rollbacker.RollbackIfCommitted(ctx, id); err != nil {
				return Result{}, fmt.Errorf("rollback prior commit for %s: %w", id, err)
			}
		}
		if err := uc.Registry.ResetStagesFor(ctx, id); err != nil {
			return Result{}, err
		}
	}

	// Move source mp3 → artifact path. Frees the input slot in the lake; the
	// artifact is now the canonical home for these bytes. Same FS = free
	// rename, EXDEV = copy-then-delete (handled in the audio store).
	if err := uc.Audio.MoveSourceFromInput(ctx, id, abs); err != nil {
		return Result{}, fmt.Errorf("move source artifact: %w", err)
	}

	// Adopt the sibling PDF (BBT/VedaBase typeset transcript) if the
	// dedup-tool placed one next to the mp3. Best-effort: a missing PDF or
	// I/O error here doesn't fail the ingest — audio is the primary deliverable.
	if _, err := uc.Audio.AdoptSiblingPDF(ctx, id, abs); err != nil {
		fmt.Fprintf(os.Stderr, "[ingest] %s: adopt sibling pdf: %v\n", id, err)
	}

	if err := uc.Registry.SetStage(ctx, id, stageKey, pipeline.StatusDone, nil, ""); err != nil {
		return Result{}, err
	}
	return Result{TrackId: id, SHA256Changed: changed}, nil
}

func canonicalPath(p string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("abs %s: %w", p, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		// File might not exist yet (rare on ingest path); fall back to abs.
		return abs, nil //nolint:nilerr
	}
	return resolved, nil
}
