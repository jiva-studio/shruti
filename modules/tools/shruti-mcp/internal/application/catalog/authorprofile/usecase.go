// Package authorprofile sets the author avatar and short bio used by the
// mobile collection-detail header. The avatar is uploaded to S3 at
// public/authors/<id>/avatar.jpg (language-neutral, recorded on every locale);
// the bio is a per-locale string.
package authorprofile

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	s3port "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// Catalog is the slice of the catalog repository this use case needs.
type Catalog interface {
	SetAuthorImage(ctx context.Context, id, key string) error
	SetAuthorDescription(ctx context.Context, id, language, description string) error
}

// UseCase wires the catalog repo and the S3 uploader. Uploader is nil when no
// S3 bucket is configured, in which case Enabled() is false.
type UseCase struct {
	Catalog  Catalog
	Uploader s3port.Uploader
}

// Enabled reports whether image upload is wired (S3 uploader present).
func (uc UseCase) Enabled() bool { return uc.Uploader != nil }

// SetDescription writes a short bio onto one (author id, language) row.
func (uc UseCase) SetDescription(ctx context.Context, id, language, description string) error {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(language) == "" {
		return fmt.Errorf("id and language are required")
	}
	return uc.Catalog.SetAuthorDescription(ctx, id, language, description)
}

// UploadImage reads the avatar from `source` (an http(s) URL or a local file
// path), normalises it to JPEG, uploads it to public/authors/<id>/avatar.jpg,
// and records the key on every locale of the author. Returns the stored key.
func (uc UseCase) UploadImage(ctx context.Context, id, source string) (string, error) {
	if !uc.Enabled() {
		return "", fmt.Errorf("image upload is not configured (no S3 bucket)")
	}
	if strings.TrimSpace(id) == "" {
		return "", fmt.Errorf("id is required")
	}
	raw, err := readSource(ctx, source)
	if err != nil {
		return "", err
	}
	jpg, err := toJPEG(raw)
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

// readSource fetches the avatar bytes from an http(s) URL or reads a local file.
func readSource(ctx context.Context, source string) ([]byte, error) {
	s := strings.TrimSpace(source)
	if s == "" {
		return nil, fmt.Errorf("source is required (http(s) URL or local file path)")
	}
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s, nil)
		if err != nil {
			return nil, err
		}
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("fetch source: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("fetch source: HTTP %d", resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 25<<20))
	}
	return os.ReadFile(s)
}

func toJPEG(data []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode source image: %w", err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}
