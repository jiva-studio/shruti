// Package collectioncover generates a cover image for a collection: it builds a
// prompt from the collection's name/description (+ an optional caller-supplied
// extra prompt and a shared style), calls the image generator, shrinks the
// result to JPEG, uploads it to S3 at public/collections/<id>/cover.jpg, and
// records the key on every locale of the collection.
package collectioncover

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // register PNG decoder for image.Decode
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/imagegen"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// Catalog is the slice of the collection repository this use case needs.
type Catalog interface {
	GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error)
	UpdateCollectionLocale(ctx context.Context, id, language string, name, cover, description, meta *string, sortOrder *int) error
}

// UseCase wires the collection repo, the image generator and the S3 uploader.
// Images/Uploader are nil when image generation isn't configured (no API key).
type UseCase struct {
	Catalog  Catalog
	Images   imagegen.Generator
	Uploader s3port.Uploader
	Style    string
}

// Enabled reports whether cover generation is wired (API key + uploader present).
func (uc UseCase) Enabled() bool { return uc.Images != nil && uc.Uploader != nil }

// Generate produces and stores a cover for the collection. `language` selects
// which locale's name/description seed the prompt (en fallback); `extra` is an
// optional caller-supplied prompt fragment to steer the result. Returns the
// stored S3 key.
func (uc UseCase) Generate(ctx context.Context, id, language, extra string) (string, error) {
	if !uc.Enabled() {
		return "", fmt.Errorf("image generation is not configured (set images.api_key)")
	}
	c, _, ok, err := uc.Catalog.GetCollection(ctx, id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("collection/%s not found", id)
	}

	name, desc := pickLocale(c, language)
	prompt := buildPrompt(name, desc, extra, uc.Style)

	raw, _, err := uc.Images.Generate(ctx, prompt)
	if err != nil {
		return "", err
	}
	jpg, err := toJPEG(raw)
	if err != nil {
		return "", err
	}

	key := fmt.Sprintf("public/collections/%s/cover.jpg", id)
	if err := uc.Uploader.Put(ctx, key, "image/jpeg", bytes.NewReader(jpg), int64(len(jpg))); err != nil {
		return "", fmt.Errorf("upload cover: %w", err)
	}

	// The art is language-neutral — record the same key on every locale.
	for lang := range c.Names {
		k := key
		if err := uc.Catalog.UpdateCollectionLocale(ctx, id, lang, nil, &k, nil, nil, nil); err != nil {
			return "", fmt.Errorf("set cover on %s/%s: %w", id, lang, err)
		}
	}
	return key, nil
}

func pickLocale(c catalog.Collection, language string) (name, desc string) {
	for _, l := range []string{language, "en"} {
		if l == "" {
			continue
		}
		if n, ok := c.Names[l]; ok && n != "" {
			return n, c.Descriptions[l]
		}
	}
	for l, n := range c.Names {
		return n, c.Descriptions[l]
	}
	return "", ""
}

func buildPrompt(name, desc, extra, style string) string {
	parts := make([]string, 0, 4)
	for _, p := range []string{name, desc, extra, style} {
		if s := strings.TrimSpace(p); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ". ")
}

func toJPEG(data []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode generated image: %w", err)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 82}); err != nil {
		return nil, fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), nil
}
