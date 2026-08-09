// Package imagegen is the port for image generation (collection covers).
package imagegen

import "context"

// Reference is an image handed to the model alongside the prompt, for the
// result to be built from rather than invented — restyling art that already
// exists instead of drawing a fresh subject.
type Reference struct {
	Data        []byte
	ContentType string // e.g. "image/jpeg"
}

// Generator turns a text prompt into image bytes. Returns the raw bytes and
// their content type (e.g. "image/png"). References are optional; a generator
// that cannot take them ignores them.
type Generator interface {
	Generate(ctx context.Context, prompt string, refs ...Reference) (data []byte, contentType string, err error)
}
