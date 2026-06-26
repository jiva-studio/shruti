// Package pipeline owns the pure (HTTP-agnostic) cut-and-upload flow.
//
// Mirrors app/pipeline.py: validate range / id, HEAD-probe the destination
// for idempotency, download → ffmpeg stream-copy → upload, return the
// public URL.
package pipeline

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"

	"github.com/akdasa-studios/lectorium-share-audio/internal/ffmpeg"
	"github.com/akdasa-studios/lectorium-share-audio/internal/logx"
	"github.com/akdasa-studios/lectorium-share-audio/internal/storage"
)

// ErrValidation wraps a request-side problem (range, id format, etc.).
// The HTTP layer maps it to 400; ServiceError maps to 502.
var ErrValidation = errors.New("validation")

// ServiceError marks an upstream failure (S3, ffmpeg) so the HTTP layer
// can return 502 instead of 500.
type ServiceError struct{ msg string }

func (e *ServiceError) Error() string { return e.msg }

func newServiceError(format string, a ...any) *ServiceError {
	return &ServiceError{msg: fmt.Sprintf(format, a...)}
}

type Cutter struct {
	Storage Storage
	FFmpeg  FFmpeg
	Bucket  string
	// Prefix is where excerpts get uploaded under (e.g.
	// "public/shares/audio"). The computed upload key is asserted to
	// live under it — guards against a future code path that
	// constructs the key elsewhere and bypasses the prefix join.
	Prefix string
	// SourceKeyPrefix is the only S3 prefix this service is willing to
	// read from. Requests with a source_key outside it return 400
	// before any S3 GET, so anonymous callers can't probe sibling
	// prefixes in the same bucket (e.g. private/backups/...).
	SourceKeyPrefix string
	MaxExcerptMs    int64
}

// Storage is the storage backend this package uses (S3/Yandex or Bunny),
// declared as an interface so the backend is swappable and tests can stub it.
type Storage = storage.Store

// FFmpeg matches ffmpeg.Cutter so tests can stub the binary call.
type FFmpeg interface {
	Cut(ctx context.Context, src, dst string, startMs, endMs int64) error
}

type Request struct {
	SourceKey string
	StartMs   int64
	EndMs     int64
	ExcerptID string // optional
}

type Result struct {
	ExcerptID string `json:"excerpt_id"`
	URL       string `json:"url"`
	Ready     bool   `json:"ready"`
}

// PrepareResult is what callers need before deciding sync (cache hit)
// vs async (dispatch a worker). Splitting Prepare out of Cut lets the
// HTTP handler answer the client without waiting on the heavy phase.
type PrepareResult struct {
	ExcerptID string
	Key       string
	URL       string
	Cached    bool
}

var safeIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Prepare validates the request, resolves the excerpt id (generating one
// if the caller omitted it), and probes S3 for an existing object. At
// most one S3 HEAD — safe to run on the request goroutine before the
// response is sent.
func (c Cutter) Prepare(ctx context.Context, req Request) (PrepareResult, error) {
	if strings.TrimSpace(req.SourceKey) == "" {
		return PrepareResult{}, fmt.Errorf("%w: source_key is required", ErrValidation)
	}
	if c.SourceKeyPrefix != "" && !strings.HasPrefix(req.SourceKey, c.SourceKeyPrefix) {
		return PrepareResult{}, fmt.Errorf("%w: source_key must start with %q", ErrValidation, c.SourceKeyPrefix)
	}
	if req.StartMs < 0 || req.EndMs <= req.StartMs {
		return PrepareResult{}, fmt.Errorf("%w: end_ms must be greater than start_ms", ErrValidation)
	}
	if req.EndMs-req.StartMs > c.MaxExcerptMs {
		return PrepareResult{}, fmt.Errorf("%w: excerpt longer than %d minutes is not supported", ErrValidation, c.MaxExcerptMs/60_000)
	}
	if req.ExcerptID != "" && !safeIDRe.MatchString(req.ExcerptID) {
		return PrepareResult{}, fmt.Errorf("%w: excerpt_id must be alphanumeric / dash / underscore (<=64 chars)", ErrValidation)
	}

	eid := req.ExcerptID
	if eid == "" {
		// uuid.uuid4().hex parity — 32 hex chars, no dashes.
		eid = strings.ReplaceAll(uuid.NewString(), "-", "")
	}
	uploadPrefix := strings.TrimRight(c.Prefix, "/") + "/"
	key := uploadPrefix + eid + ".mp3"
	if !strings.HasPrefix(key, uploadPrefix) {
		return PrepareResult{}, newServiceError("computed excerpt key %q escapes prefix %q", key, uploadPrefix)
	}

	exists := false
	url := ""
	if c.Storage != nil {
		ok, err := c.Storage.Exists(ctx, key)
		if err != nil {
			return PrepareResult{}, newServiceError("head failed: %s", err)
		}
		exists = ok
		url = c.Storage.BuildURL(key)
	}
	return PrepareResult{
		ExcerptID: eid,
		Key:       key,
		URL:       url,
		Cached:    exists,
	}, nil
}

// Cut runs the full pipeline synchronously — validate, cache-check,
// download, ffmpeg, upload — and returns the public URL with Ready:true.
// The HTTP handler uses Prepare + Dispatcher to keep the client off this
// goroutine; Cut is still the entry point for the background worker and
// for any future sync caller.
func (c Cutter) Cut(ctx context.Context, req Request) (Result, error) {
	log := logx.From(ctx)

	prep, err := c.Prepare(ctx, req)
	if err != nil {
		return Result{}, err
	}
	if prep.Cached {
		log.Info("excerpt_cache_hit", "excerpt_id", prep.ExcerptID, "key", prep.Key)
		return Result{ExcerptID: prep.ExcerptID, URL: prep.URL, Ready: true}, nil
	}

	tmp, err := os.MkdirTemp("", "share-audio-*")
	if err != nil {
		return Result{}, newServiceError("mktemp: %s", err)
	}
	defer os.RemoveAll(tmp)
	src := filepath.Join(tmp, "source.mp3")
	dst := filepath.Join(tmp, "excerpt.mp3")

	log.Info("excerpt_download_start", "bucket", c.Bucket, "source_key", req.SourceKey, "excerpt_id", prep.ExcerptID)
	if err := c.Storage.DownloadTo(ctx, req.SourceKey, src); err != nil {
		return Result{}, newServiceError("download failed: %s", err)
	}

	if err := c.FFmpeg.Cut(ctx, src, dst, req.StartMs, req.EndMs); err != nil {
		return Result{}, newServiceError("ffmpeg failed: %s", err)
	}

	log.Info("excerpt_upload_start", "bucket", c.Bucket, "key", prep.Key, "excerpt_id", prep.ExcerptID)
	if err := c.Storage.Upload(ctx, prep.Key, dst, "audio/mpeg", ""); err != nil {
		return Result{}, newServiceError("upload failed: %s", err)
	}
	log.Info("excerpt_done", "excerpt_id", prep.ExcerptID, "key", prep.Key)

	return Result{ExcerptID: prep.ExcerptID, URL: prep.URL, Ready: true}, nil
}

// FromFFmpegBin is a small constructor sugar for cmd/main.
func FromFFmpegBin(bin string) FFmpeg { return ffmpeg.Cutter{Bin: bin} }
