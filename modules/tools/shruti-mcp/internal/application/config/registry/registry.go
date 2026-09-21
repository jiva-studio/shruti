// Package configregistry is the extensible catalog of config keys the MCP
// `config.*` tools can read and write into the catalog `settings` store.
//
// Each key registers a Descriptor — value model (JSON Schema) + human/agent
// description + a validator. The server validates every write against the
// registered validator, and `config.describe` exposes the schemas so an agent
// can discover what configs exist and the exact shape each expects. Adding a
// new config is one Register call — no per-key tool, no parser changes.
package configregistry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// ValidateDeps carries the side data validators need to check referential
// integrity (e.g. that a topic id exists in the catalog). Extend as new
// descriptors need more lookups.
type ValidateDeps struct {
	// TopicExists reports whether a topic id is present in the catalog.
	TopicExists func(ctx context.Context, id string) (bool, error)
}

// Descriptor declares one config key: its value model, a description, and a
// validator. Validate receives the raw value bytes (as sent to config.set)
// and the shared deps.
type Descriptor struct {
	Key         string
	Description string
	Schema      json.RawMessage
	Validate    func(ctx context.Context, raw []byte, deps ValidateDeps) error
}

// Registry holds the registered descriptors and the deps their validators use.
type Registry struct {
	deps  ValidateDeps
	byKey map[string]Descriptor
	order []string
}

// New builds an empty registry bound to the given validate deps.
func New(deps ValidateDeps) *Registry {
	return &Registry{deps: deps, byKey: map[string]Descriptor{}}
}

// Register adds (or replaces) a descriptor.
func (r *Registry) Register(d Descriptor) error {
	if d.Key == "" {
		return errors.New("configregistry: descriptor with empty key")
	}
	if _, exists := r.byKey[d.Key]; !exists {
		r.order = append(r.order, d.Key)
	}
	r.byKey[d.Key] = d
	return nil
}

// Get returns the descriptor for a key.
func (r *Registry) Get(key string) (Descriptor, bool) {
	d, ok := r.byKey[key]
	return d, ok
}

// Keys returns the registered keys, sorted.
func (r *Registry) Keys() []string {
	out := append([]string(nil), r.order...)
	sort.Strings(out)
	return out
}

// Describe returns all descriptors, sorted by key — drives config.describe.
func (r *Registry) Describe() []Descriptor {
	out := make([]Descriptor, 0, len(r.byKey))
	for _, k := range r.Keys() {
		out = append(out, r.byKey[k])
	}
	return out
}

// Validate looks up the key and runs its validator against raw. Returns an
// error for an unknown key or an invalid value.
func (r *Registry) Validate(ctx context.Context, key string, raw []byte) error {
	d, ok := r.byKey[key]
	if !ok {
		return fmt.Errorf("unknown config key %q", key)
	}
	if d.Validate == nil {
		return nil
	}
	return d.Validate(ctx, raw, r.deps)
}
