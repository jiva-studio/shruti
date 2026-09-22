// Package parse is the single-URL dry run: give it one address, see exactly
// what came out, write nothing.
//
// It is the main way to work on this service. The answer comes back in three
// layers, so a bad result shows you where it broke rather than just being
// wrong.
package parse

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/extract"
)

// Fetcher is the polite HTTP client, narrowed to what parse needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req domain.FetchRequest) (*domain.FetchResponse, error)
}

// Layers is what one URL produced.
type Layers struct {
	// Extracted is what came off the page: text, media URLs, the context around
	// each, links worth visiting.
	Extracted *domain.Extraction `json:"extracted"`
	// NormalizerInput is exactly what the model is asked about. This is what
	// gets hashed, so an unchanged page costs no call.
	NormalizerInput normalize.Batch `json:"normalizer_input"`
	// InputHashes are those hashes, one per file, in the same order.
	InputHashes []string `json:"input_hashes,omitempty"`
	// Normalized is what the model said, after validation. Nil when no
	// normalizer is configured.
	Normalized []normalize.Result `json:"normalized,omitempty"`

	Status      int    `json:"status,omitempty"`
	ContentType string `json:"content_type,omitempty"`
}

// Service runs the dry run. Normalizer may be nil: extraction still works and
// still shows layers one and two, which is the whole no-key path.
type Service struct {
	Fetcher    Fetcher
	Normalizer normalize.Normalizer
}

// URL fetches one address and reports what it yielded. Nothing is stored and
// nothing is scheduled. req carries the source's credentials and pace, if it
// has any.
func (s *Service) URL(ctx context.Context, rawURL string, req domain.FetchRequest) (*Layers, error) {
	if s.Fetcher == nil {
		return nil, fmt.Errorf("parse: no fetcher configured")
	}
	resp, err := s.Fetcher.Get(ctx, rawURL, req)
	if err != nil {
		return nil, err
	}
	layers, err := s.body(ctx, resp.Body, resp.ContentType, resp.URL)
	if err != nil {
		return nil, err
	}
	layers.Status = resp.Status
	layers.ContentType = resp.ContentType
	return layers, nil
}

// Body parses a response someone already has, so extraction can be worked on
// against a saved page without fetching it again.
func (s *Service) Body(ctx context.Context, body []byte, contentType, baseURL string) (*Layers, error) {
	return s.body(ctx, body, contentType, baseURL)
}

func (s *Service) body(ctx context.Context, body []byte, contentType, baseURL string) (*Layers, error) {
	extraction, err := extract.Parse(body, contentType, baseURL)
	if err != nil {
		return nil, err
	}

	layers := &Layers{
		Extracted:       extraction,
		NormalizerInput: normalize.BatchFor(extraction),
	}
	if s.Normalizer == nil {
		return layers, nil
	}

	version, model := s.Normalizer.PromptVersion(), s.Normalizer.Model()
	for i := range layers.NormalizerInput.Items {
		layers.InputHashes = append(layers.InputHashes,
			normalize.InputHash(layers.NormalizerInput, i, version, model))
	}
	if len(layers.NormalizerInput.Items) == 0 {
		return layers, nil
	}

	results, err := s.Normalizer.Normalize(ctx, layers.NormalizerInput)
	if err != nil {
		return nil, err
	}
	layers.Normalized = results
	return layers, nil
}
