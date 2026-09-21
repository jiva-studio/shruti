// Package runregistry is the port the application's runner.Runner uses
// to persist and query async runs. The MCP layer (runs_list / run_status
// / run_wait / run_cancel) reaches the same registry through a thin
// read-only facade.
//
// Implementations live under internal/infra/runregistry/{memory,sqlite}.
// In-memory v1 is enough — runs aren't durable across daemon restarts
// yet (next iteration adds SQLite-backed persistence).
package runregistry

import (
	"context"
	"errors"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
)

// ErrNotFound is returned by Get / Update / Cancel when no run with the
// given id is in the registry.
var ErrNotFound = errors.New("run: not found")

// ErrTerminal is returned by Update / Cancel when the caller tries to
// mutate a run that's already in a terminal state. Callers treat this
// as benign for cancel (already done, nothing to do) and as a bug for
// update (the runner shouldn't push progress past terminal).
var ErrTerminal = errors.New("run: terminal")

// Registry is the persistence + lookup port for async runs.
type Registry interface {
	// Submit records a new run in StateQueued and returns it back. The
	// implementation is responsible for filling ID (callers may supply
	// one via r.ID; if empty the registry mints).
	Submit(ctx context.Context, r run.Run) (run.Run, error)

	// Get returns the run with the given id, or ErrNotFound.
	Get(ctx context.Context, id string) (run.Run, error)

	// Update replaces the persisted run with the supplied snapshot. The
	// caller is expected to have walked through Run.Transition() so the
	// state field is already validated. Implementations refuse updates
	// to runs already in terminal state (ErrTerminal).
	Update(ctx context.Context, r run.Run) error

	// List returns runs filtered by ListOptions. Default ordering is
	// most-recently-started first.
	List(ctx context.Context, opts ListOptions) ([]run.Run, error)

	// Cancel transitions a run to StateCancelled and triggers the
	// associated context cancel func (set up via SetCancelFunc). Idempotent
	// when the run is already terminal.
	Cancel(ctx context.Context, id string) error

	// SetCancelFunc registers the goroutine-side cancel hook for a run.
	// The runner calls this immediately after Submit and before launching
	// the work goroutine — so a Cancel() arriving in that window is
	// observed by the worker as ctx.Done().
	SetCancelFunc(id string, cancel context.CancelFunc) error
}

// ListOptions narrows what List returns. Zero-value means "active +
// recent", limit 50 — sane defaults for runs_list.
type ListOptions struct {
	Kind  run.Kind  // empty = any
	State run.State // empty = active+recent (queued/running plus the most-recently-finished entries up to Limit)
	Limit int       // <=0 → 50
}

// DefaultListLimit is what implementations use when ListOptions.Limit is
// zero or negative.
const DefaultListLimit = 50
