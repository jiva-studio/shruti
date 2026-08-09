// Package covergen generates a cover image for any catalog entity (collection,
// topic, …): it builds a prompt from the entity's name/description (+ an
// optional caller-supplied extra prompt and a shared style), calls the image
// generator, shrinks the result to JPEG, uploads it to S3 at
// <prefix>/<id>/cover.jpg, and records the key on the entity. The entity-
// specific bits — how to read the seed and where to store the key — are a small
// Repo the caller supplies; the generation pipeline lives here once.
package covergen

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/imageutil"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/imagegen"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// Subject is one entity's locale-picked seed for the prompt.
type Subject struct {
	Name string
	Desc string
}

// Repo is the entity-specific slice covergen needs: read the prompt seed for an
// id+language (ok=false when the entity is absent) and store the resulting cover
// key on the entity (all locales).
type Repo interface {
	CoverSubject(ctx context.Context, id, language string) (Subject, bool, error)
	SetCover(ctx context.Context, id, key string) error
}

// UseCase wires the entity repo, the image generator and the S3 uploader.
// Images/Uploader are nil when image generation isn't configured (no API key).
type UseCase struct {
	Repo     Repo
	Prefix   string // S3 key prefix, e.g. "public/collections" or "public/topics"
	Images   imagegen.Generator
	Uploader s3port.Uploader
	Style    string
}

// Enabled reports whether cover generation is wired (API key + uploader present).
func (uc UseCase) Enabled() bool { return uc.Images != nil && uc.Uploader != nil }

// Option tunes one Generate call.
type Option func(*options)

type options struct{ restyle bool }

// Restyle makes the model redraw the entity's current cover instead of
// inventing a subject: the existing image goes in with the prompt, so what it
// depicts survives while the palette and the resolution become the house
// style's. A no-op when the entity has no cover yet.
func Restyle() Option { return func(o *options) { o.restyle = true } }

// Generate produces and stores a cover for the entity. `language` selects which
// locale's name/description seed the prompt (caller's Repo owns the fallback);
// `extra` is an optional caller-supplied prompt fragment. Returns the stored S3
// key.
func (uc UseCase) Generate(ctx context.Context, id, language, extra string, opts ...Option) (string, error) {
	if !uc.Enabled() {
		return "", fmt.Errorf("image generation is not configured (set images.api_key)")
	}
	var o options
	for _, fn := range opts {
		fn(&o)
	}
	s, ok, err := uc.Repo.CoverSubject(ctx, id, language)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%s/%s not found", uc.Prefix, id)
	}

	var refs []imagegen.Reference
	if o.restyle {
		key := fmt.Sprintf("%s/%s/cover.jpg", uc.Prefix, id)
		body, found, err := uc.Uploader.Get(ctx, key)
		if err != nil {
			return "", fmt.Errorf("read current cover %s: %w", key, err)
		}
		if found {
			refs = append(refs, imagegen.Reference{Data: body, ContentType: "image/jpeg"})
		}
	}

	prompt := buildPrompt(s.Name, s.Desc, extra, uc.Style)
	if len(refs) > 0 {
		prompt = restylePreamble + " " + prompt
	}
	raw, _, err := uc.Images.Generate(ctx, prompt, refs...)
	if err != nil {
		return "", err
	}
	jpg, err := imageutil.ToJPEG(raw, 82)
	if err != nil {
		return "", err
	}

	key := fmt.Sprintf("%s/%s/cover.jpg", uc.Prefix, id)
	if err := uc.Uploader.Put(ctx, key, "image/jpeg", bytes.NewReader(jpg), int64(len(jpg))); err != nil {
		return "", fmt.Errorf("upload cover: %w", err)
	}
	if err := uc.Repo.SetCover(ctx, id, key); err != nil {
		return "", fmt.Errorf("set cover on %s: %w", id, err)
	}
	return key, nil
}

// restylePreamble tells the model the attached image is the subject to repaint,
// not a sample of the wanted style — without it a reference is as likely to be
// copied as reinterpreted.
const restylePreamble = "Repaint the attached image in the style described below. " +
	"Keep its subject, composition and what it depicts; change only the rendering, " +
	"palette and finish. Output a single square image at full resolution."

func buildPrompt(name, desc, extra, style string) string {
	parts := make([]string, 0, 4)
	for _, p := range []string{name, desc, extra, style} {
		if s := strings.TrimSpace(p); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, ". ")
}
