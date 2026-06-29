// Package media is the application use case for the library.import MCP tool.
// It mints a media id, uploads the local file (and an optional sibling poster)
// to S3, then upserts a library_media row. One plan record → one media row.
// A record may carry a stable caller-supplied "id" for true idempotency (same
// id → same S3 key → overwrite, and INSERT OR REPLACE → same row); when "id"
// is empty a fresh nanoid is minted. No external checkpoint needed.
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/ids"
	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

const idPrefix = "media_"

// safeID restricts caller-supplied ids to characters safe as an S3 key /
// filename segment: alphanumerics, underscore, and hyphen.
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// MediaWriter is the repo write surface the use case needs.
type MediaWriter interface {
	MediaUpsert(ctx context.Context, m library.Media) error
}

// UseCase wires the media repo writer, the S3 targets, and the id minter.
// Targets mirrors the publish path (first is primary); a single AWS target is
// enough — the Yandex mirror is synced externally.
type UseCase struct {
	Repo    MediaWriter
	Targets []s3port.Uploader
	Minter  ids.Minter
}

// Record is one item in an import plan.
type Record struct {
	ID        string          `json:"id"`
	Lang      string          `json:"lang"`
	Title     string          `json:"title"`
	Text      string          `json:"text"`
	Context   string          `json:"context"`
	EmbedText string          `json:"embed_text"`
	Type      string          `json:"type"`
	MediaPath string          `json:"media_path"`
	Meta      json.RawMessage `json:"meta"`
}

// Plan is the import payload: a flat list of media records.
type Plan struct {
	Records []Record `json:"records"`
}

// Result is the rollup returned to the caller.
type Result struct {
	Imported int      `json:"imported"`
	IDs      []string `json:"ids"`
}

// ProgressTick reports per-record progress for the async runner.
type ProgressTick struct {
	FilesDone  int
	FilesTotal int
}

// Options carries the parsed plan plus an optional progress callback.
type Options struct {
	Plan       Plan
	OnProgress func(p ProgressTick)
}

// ParsePlan unmarshals + validates an import plan.
func ParsePlan(data []byte) (Plan, error) {
	var p Plan
	if err := json.Unmarshal(data, &p); err != nil {
		return Plan{}, fmt.Errorf("parse json: %w", err)
	}
	if len(p.Records) == 0 {
		return Plan{}, fmt.Errorf("import plan: `records` is empty")
	}
	for i, r := range p.Records {
		if strings.TrimSpace(r.Lang) == "" {
			return Plan{}, fmt.Errorf("import plan: records[%d] missing lang", i)
		}
		if strings.TrimSpace(r.Title) == "" {
			return Plan{}, fmt.Errorf("import plan: records[%d] missing title", i)
		}
		if strings.TrimSpace(r.Type) == "" {
			return Plan{}, fmt.Errorf("import plan: records[%d] missing type", i)
		}
		if strings.TrimSpace(r.MediaPath) == "" {
			return Plan{}, fmt.Errorf("import plan: records[%d] missing media_path", i)
		}
		if r.ID != "" {
			if strings.TrimSpace(r.ID) == "" {
				return Plan{}, fmt.Errorf("import plan: records[%d] id is blank", i)
			}
			if !safeID.MatchString(r.ID) {
				return Plan{}, fmt.Errorf("import plan: records[%d] id %q must contain only [A-Za-z0-9_-]", i, r.ID)
			}
		}
	}
	return p, nil
}

// Run imports every record: mint id → upload file (+ optional sibling poster)
// → upsert row. Fails fast on the first error (a half-uploaded record is safe
// to re-run since uploads and the upsert are overwrite-by-key/by-id).
func (uc UseCase) Run(ctx context.Context, opts Options) (Result, error) {
	if len(uc.Targets) == 0 {
		return Result{}, fmt.Errorf("no S3 targets configured")
	}
	if uc.Minter == nil {
		return Result{}, fmt.Errorf("id minter not configured")
	}

	res := Result{}
	total := len(opts.Plan.Records)
	emit := func(done int) {
		if opts.OnProgress != nil {
			opts.OnProgress(ProgressTick{FilesDone: done, FilesTotal: total})
		}
	}

	for i, rec := range opts.Plan.Records {
		id := rec.ID
		if id == "" {
			id = idPrefix + uc.Minter.MintTail()
		}
		ext := filepath.Ext(rec.MediaPath)
		mediaKey := fmt.Sprintf("public/media/%s%s", id, ext)

		if err := uc.upload(ctx, rec.MediaPath, mediaKey); err != nil {
			return res, fmt.Errorf("records[%d] upload media: %w", i, err)
		}

		// Optional sibling poster: <media_path without ext>.jpg → public/media/<id>.jpg
		posterPath := strings.TrimSuffix(rec.MediaPath, ext) + ".jpg"
		if _, err := os.Stat(posterPath); err == nil {
			posterKey := fmt.Sprintf("public/media/%s.jpg", id)
			if err := uc.upload(ctx, posterPath, posterKey); err != nil {
				return res, fmt.Errorf("records[%d] upload poster: %w", i, err)
			}
		}

		meta := ""
		if len(rec.Meta) > 0 && string(rec.Meta) != "null" {
			meta = string(rec.Meta)
		}
		if err := uc.Repo.MediaUpsert(ctx, library.Media{
			ID:        id,
			Lang:      rec.Lang,
			Title:     rec.Title,
			Text:      rec.Text,
			Context:   rec.Context,
			EmbedText: rec.EmbedText,
			URL:       mediaKey,
			Type:      rec.Type,
			Meta:      meta,
		}); err != nil {
			return res, fmt.Errorf("records[%d] upsert: %w", i, err)
		}

		res.IDs = append(res.IDs, id)
		res.Imported++
		emit(i + 1)
	}
	return res, nil
}

// upload pushes one local file to the given key on every target (primary +
// any mirror). Content-type is inferred from the file extension.
func (uc UseCase) upload(ctx context.Context, localPath, key string) error {
	info, err := os.Stat(localPath)
	if err != nil {
		return fmt.Errorf("stat %s: %w", localPath, err)
	}
	contentType := mime.TypeByExtension(filepath.Ext(localPath))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	for _, target := range uc.Targets {
		f, err := os.Open(localPath)
		if err != nil {
			return fmt.Errorf("open %s: %w", localPath, err)
		}
		err = target.Put(ctx, key, contentType, f, info.Size())
		_ = f.Close()
		if err != nil {
			return fmt.Errorf("put %s (%s): %w", key, target.Name(), err)
		}
	}
	return nil
}
