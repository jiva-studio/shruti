// Package imagegen is the port for text-to-image generation (collection covers).
package imagegen

import "context"

// Generator turns a text prompt into image bytes. Returns the raw bytes and
// their content type (e.g. "image/png").
type Generator interface {
	Generate(ctx context.Context, prompt string) (data []byte, contentType string, err error)
}
