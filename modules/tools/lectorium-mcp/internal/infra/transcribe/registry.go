// Package transcribereg registers the available transcriber backends.
package transcribereg

import (
	"sync"

	"github.com/jiva-studio/lectorium/pipeline/ports/transcriber"
)

// Registry implements transcriber.Registry.
type Registry struct {
	mu      sync.RWMutex
	items   map[string]transcriber.Transcriber
	defName string
}

func New() *Registry {
	return &Registry{items: map[string]transcriber.Transcriber{}}
}

func (r *Registry) Register(t transcriber.Transcriber) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[t.Name()] = t
	if r.defName == "" {
		r.defName = t.Name()
	}
}

func (r *Registry) SetDefault(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.defName = name
}

func (r *Registry) Get(name string) (transcriber.Transcriber, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	t, ok := r.items[name]
	return t, ok
}

func (r *Registry) Default() transcriber.Transcriber {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.items[r.defName]
}

func (r *Registry) List() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.items))
	for n := range r.items {
		out = append(out, n)
	}
	return out
}

var _ transcriber.Registry = (*Registry)(nil)
