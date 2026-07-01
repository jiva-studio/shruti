// Package transcriber holds the engine registry and the concrete transcription
// adapters (subpackages). Adding an engine = a new subpackage + one Register
// call at composition time; the application core never imports engines directly.
package transcriber

import (
	"fmt"
	"sort"

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
)

// Factory builds a fresh Transcriber for an engine.
type Factory func() port.Transcriber

// Registry maps provider ids to factories. It implements port.TranscriberFactory.
type Registry struct {
	factories map[domain.ProviderID]Factory
	fallback  domain.ProviderID
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{factories: map[domain.ProviderID]Factory{}}
}

var _ port.TranscriberFactory = (*Registry)(nil)

// Register adds an engine. The first registered id becomes the fallback used
// when an empty/unknown id is requested.
func (r *Registry) Register(id domain.ProviderID, f Factory) {
	r.factories[id] = f
	if r.fallback == "" {
		r.fallback = id
	}
}

// SetDefault overrides which id is used when an empty id is requested.
func (r *Registry) SetDefault(id domain.ProviderID) { r.fallback = id }

// Transcriber resolves an engine ("" → the default/fallback).
func (r *Registry) Transcriber(id domain.ProviderID) (port.Transcriber, error) {
	if id == "" {
		id = r.fallback
	}
	f, ok := r.factories[id]
	if !ok {
		return nil, fmt.Errorf("transcriber: unknown provider %q (have %v)", id, r.IDs())
	}
	return f(), nil
}

// IDs lists registered provider ids (sorted, for stable errors/UX).
func (r *Registry) IDs() []domain.ProviderID {
	ids := make([]domain.ProviderID, 0, len(r.factories))
	for id := range r.factories {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}
