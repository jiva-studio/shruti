// Package authorprofile sets the author avatar and short bio used by the
// mobile collection-detail header. The avatar is uploaded to S3 at
// public/authors/<id>/avatar.jpg (language-neutral, recorded on every locale);
// the bio is a per-locale string.
package authorprofile

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// Catalog is the slice of the catalog repository this use case needs.
type Catalog interface {
	SetAuthorImage(ctx context.Context, id, key string) error
	SetAuthorDescription(ctx context.Context, id, language, description string) error
}

// Source reads the image an operator points at: an http(s) URL or a local
// file path.
type Source interface {
	Read(ctx context.Context, source string) ([]byte, error)
}

// JPEGEncoder re-encodes an image as JPEG at a quality.
type JPEGEncoder interface {
	Encode(data []byte, quality int) ([]byte, error)
}

// UseCase wires the catalog repo, the image source and encoder, and the S3
// uploader. Uploader is nil when no S3 bucket is configured, in which case
// Enabled() is false.
type UseCase struct {
	Catalog  Catalog
	Source   Source
	JPEG     JPEGEncoder
	Uploader s3port.Uploader
}

// Enabled reports whether image upload is wired (S3 uploader present).
func (uc UseCase) Enabled() bool { return uc.Uploader != nil }

// SetDescription writes a short bio onto one (author id, language) row.
func (uc UseCase) SetDescription(ctx context.Context, id, language, description string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(language) == "" {
		return errors.New("id and language are required")
	}
	return uc.Catalog.SetAuthorDescription(ctx, id, language, description)
}

// UploadImage reads the avatar from `source` (an http(s) URL or a local file
// path), normalises it to JPEG, uploads it to public/authors/<id>/avatar.jpg,
// and records the key on every locale of the author. Returns the stored key.
func (uc UseCase) UploadImage(ctx context.Context, id, source string) (string, error) {
	if !uc.Enabled() {
		return "", errors.New("image upload is not configured (no S3 bucket)")
	}
	if strings.TrimSpace(id) == "" {
		return "", errors.New("id is required")
	}
	raw, err := uc.Source.Read(ctx, source)
	if err != nil {
		return "", err
	}
	jpg, err := uc.JPEG.Encode(raw, 85)
	if err != nil {
		return "", err
	}
	key := fmt.Sprintf("public/authors/%s/avatar.jpg", id)
	if err := uc.Uploader.Put(ctx, key, "image/jpeg", bytes.NewReader(jpg), int64(len(jpg))); err != nil {
		return "", fmt.Errorf("upload avatar: %w", err)
	}
	if err := uc.Catalog.SetAuthorImage(ctx, id, key); err != nil {
		return "", err
	}
	return key, nil
}
