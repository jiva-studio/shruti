// Package memory is the in-memory implementation of runregistry.Registry.
// Runs live for the lifetime of the daemon process — no persistence
// across restarts. Good enough for v1; SQLite-backed adapter lands when
// runs need to survive `make restart`.
package memory

import (
	"context"
	"sort"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/ids/nanoid"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/runregistry"
)

// Registry is the in-memory store. Safe for concurrent use.
type Registry struct {
	mu      sync.Mutex
	runs    map[string]run.Run
	cancels map[string]context.CancelFunc
	minter  IDMinter
}

// IDMinter mints run ids when the caller doesn't supply one. Defaults to
// nanoid (matches the rest of the daemon's id style); injectable for tests.
type IDMinter interface {
	MintTail() string
}

// New constructs an in-memory Registry with the default nanoid minter.
func New() *Registry {
	return &Registry{
		runs:    map[string]run.Run{},
		cancels: map[string]context.CancelFunc{},
		minter:  nanoid.New(),
	}
}

// NewWithMinter is the test seam.
func NewWithMinter(m IDMinter) *Registry {
	return &Registry{
		runs:    map[string]run.Run{},
		cancels: map[string]context.CancelFunc{},
		minter:  m,
	}
}

func (r *Registry) Submit(_ context.Context, in run.Run) (run.Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if in.Id == "" {
		in.Id = "run_" + r.minter.MintTail()
	}
	if in.State == "" {
		in.State = run.StateQueued
	}
	r.runs[in.Id] = in
	return in, nil
}

func (r *Registry) Get(_ context.Context, id string) (run.Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.runs[id]
	if !ok {
		return run.Run{}, runregistry.ErrNotFound
	}
	return v, nil
}

func (r *Registry) Update(_ context.Context, in run.Run) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev, ok := r.runs[in.Id]
	if !ok {
		return runregistry.ErrNotFound
	}
	if prev.State.IsTerminal() {
		return runregistry.ErrTerminal
	}
	r.runs[in.Id] = in
	if in.State.IsTerminal() {
		// Drop the cancel func — Cancel() after this is a no-op.
		delete(r.cancels, in.Id)
	}
	return nil
}

func (r *Registry) List(_ context.Context, opts runregistry.ListOptions) ([]run.Run, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = runregistry.DefaultListLimit
	}
	r.mu.Lock()
	all := make([]run.Run, 0, len(r.runs))
	for _, v := range r.runs {
		if opts.Kind != "" && v.Kind != opts.Kind {
			continue
		}
		if opts.State != "" && v.State != opts.State {
			continue
		}
		all = append(all, v)
	}
	r.mu.Unlock()

	// Order: most-recently-started first. Stable on equal timestamps.
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].StartedAt.After(all[j].StartedAt)
	})

	if opts.State == "" {
		// Default "active + recent": prefer non-terminal first, then fill
		// with the most recent terminals up to the limit.
		var active, terminal []run.Run
		for _, v := range all {
			if v.State.IsTerminal() {
				terminal = append(terminal, v)
			} else {
				active = append(active, v)
			}
		}
		all = append(active, terminal...)
	}
	if len(all) > limit {
		all = all[:limit]
	}
	return all, nil
}

func (r *Registry) Cancel(_ context.Context, id string) error {
	r.mu.Lock()
	prev, ok := r.runs[id]
	if !ok {
		r.mu.Unlock()
		return runregistry.ErrNotFound
	}
	if prev.State.IsTerminal() {
		r.mu.Unlock()
		return nil // already done — idempotent
	}
	cancel := r.cancels[id]
	delete(r.cancels, id)

	// Apply the state transition under the lock so concurrent Update vs
	// Cancel can't race to a "running but not-cancelled" state.
	next, err := prev.Transition(run.StateCancelled)
	if err != nil {
		r.mu.Unlock()
		return err
	}
	next.Error = "cancelled"
	r.runs[id] = next
	r.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	return nil
}

func (r *Registry) SetCancelFunc(id string, cancel context.CancelFunc) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.runs[id]; !ok {
		return runregistry.ErrNotFound
	}
	r.cancels[id] = cancel
	return nil
}

// Compile-time check.
var _ runregistry.Registry = (*Registry)(nil)
