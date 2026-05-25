// Package handlers wires event_type -> handler function. The worker only
// knows about (event_type, payload); the registry is where the project
// decides which handlers run for which events.
//
// Convention: one handler per event today, but the registry supports
// multiple. If you ever fan out (e.g. user.deleted purges Langfuse AND
// wipes an S3 prefix), register both — the worker only marks the row
// processed after every handler has returned nil.
package handlers

import (
	"context"

	cwdb "github.com/akdasa-studios/lectorium/cleanup-worker/internal/db"
)

// Event is re-exported so handler files don't need to import the db
// package directly (which would couple every handler to pgx).
type Event = cwdb.Event

// Handler is the contract every consumer implements. Idempotency is
// required: a handler may be invoked twice for the same row if the
// worker crashed between the side-effect completing and the UPDATE
// landing.
type Handler func(ctx context.Context, evt Event) error

// Registry maps event_type → ordered list of handlers. Not thread-safe;
// build it at boot, hand it to the worker read-only.
type Registry struct {
	handlers map[string][]Handler
}

func NewRegistry() *Registry {
	return &Registry{handlers: map[string][]Handler{}}
}

// Register appends h to the chain for eventType. Order of Register calls
// is the order handlers run; first error short-circuits the chain.
func (r *Registry) Register(eventType string, h Handler) {
	r.handlers[eventType] = append(r.handlers[eventType], h)
}

// HandlersFor returns the chain for eventType, or nil if nothing's
// registered. Callers should treat nil as "no handler — log and skip,
// do NOT mark the row processed" so the row stays available for
// inspection.
func (r *Registry) HandlersFor(eventType string) []Handler {
	return r.handlers[eventType]
}

// KnownEventTypes returns every event_type with at least one handler.
// Used by main to log the boot-time wiring.
func (r *Registry) KnownEventTypes() []string {
	out := make([]string, 0, len(r.handlers))
	for k := range r.handlers {
		out = append(out, k)
	}
	return out
}
