// Package runner is the application-side wrapper that turns any unit of
// work into a tracked async run. MCP tools call Submit() with a kind +
// the work function; the runner spawns a goroutine, threads context
// cancellation, pushes progress ticks into the registry, and writes the
// final result/error.
//
// One Runner is shared across all MCP tools. Persistence + lookup live
// in runregistry.Registry; this package owns lifecycle.
package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime/debug"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	clockport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/clock"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/runregistry"
)

// Runner submits work to runregistry.Registry and drives it through
// queued → running → terminal state.
type Runner struct {
	Registry runregistry.Registry
	Clock    clockport.Clock
}

// New constructs a Runner.
func New(reg runregistry.Registry, clk clockport.Clock) *Runner {
	return &Runner{Registry: reg, Clock: clk}
}

// Spec is the input to Submit. WorkFn does the actual work; the runner
// passes it a derived context that gets cancelled when run_cancel hits.
// progressFn is the channel for the work to push live counters into the
// registry — call it as often as makes sense (every file, every chunk,
// every percent — runner doesn't throttle).
type Spec struct {
	Kind        run.Kind
	Cancellable bool

	// Initial run shape: Selector / Targets / Progress.FilesTotal etc.
	// The runner copies these onto the persisted Run before launching.
	Init run.Run

	// WorkFn runs in a fresh goroutine. `report` lets it push progress;
	// the returned bytes (json) are stored as Run.Result on success.
	WorkFn func(ctx context.Context, report ProgressFn) (json.RawMessage, error)
}

// ProgressFn updates the run's progress in the registry. Best-effort —
// errors are swallowed (the work goroutine shouldn't have to think
// about registry plumbing).
type ProgressFn func(p run.Progress)

// Submit enqueues the run, kicks off the work goroutine, returns the
// run id. Caller is expected to surface that id back to the MCP client
// so it can poll / wait / cancel.
func (r *Runner) Submit(ctx context.Context, spec Spec) (string, error) {
	if r == nil || r.Registry == nil {
		return "", errors.New("runner: registry not configured")
	}
	if spec.Kind == "" {
		return "", errors.New("runner: kind required")
	}
	if spec.WorkFn == nil {
		return "", errors.New("runner: WorkFn required")
	}

	// Build the initial Run record.
	rec := run.New(spec.Init.ID, spec.Kind, r.Clock.Now().UTC())
	rec.Selector = spec.Init.Selector
	rec.Targets = spec.Init.Targets
	rec.Progress = spec.Init.Progress
	rec.Cancellable = spec.Cancellable

	rec, err := r.Registry.Submit(ctx, rec)
	if err != nil {
		return "", fmt.Errorf("submit: %w", err)
	}

	// Cancel hook: the caller's cancellation is dropped so the run keeps
	// going after the MCP request returns. run_cancel hits this CancelFunc.
	workCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	if spec.Cancellable {
		if err := r.Registry.SetCancelFunc(rec.ID, cancel); err != nil {
			cancel()
			return "", fmt.Errorf("register cancel: %w", err)
		}
	}

	go r.run(workCtx, cancel, rec, spec.WorkFn)
	return rec.ID, nil
}

func (r *Runner) run(ctx context.Context, cancel context.CancelFunc, initial run.Run, work func(context.Context, ProgressFn) (json.RawMessage, error)) {
	defer cancel()

	// Transition to running.
	rec := initial
	if next, err := rec.Transition(run.StateRunning, r.Clock.Now().UTC()); err == nil {
		rec = next
		_ = r.Registry.Update(ctx, rec)
	}

	// Progress reporter.
	report := func(p run.Progress) {
		// Fetch the latest snapshot (Cancel may have already terminated
		// the run between progress ticks). Skip the update if so.
		latest, err := r.Registry.Get(ctx, rec.ID)
		if err != nil {
			return
		}
		if latest.State.IsTerminal() {
			rec = latest
			return
		}
		latest.Progress = p
		_ = r.Registry.Update(ctx, latest)
		rec = latest
	}

	// Run the work, recover from panics so a synthetic crash doesn't
	// strand the registry entry as `running` forever.
	var (
		result json.RawMessage
		err    error
	)
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				err = fmt.Errorf("panic: %v\n%s", rec, debug.Stack())
			}
		}()
		result, err = work(ctx, report)
	}()

	// Final transition. Refetch so a concurrent Cancel that beat us to
	// terminal state doesn't get clobbered. The work's own cancellation must
	// not stop the terminal state from being recorded.
	bookkeeping := context.WithoutCancel(ctx)
	final, gerr := r.Registry.Get(bookkeeping, rec.ID)
	if gerr != nil {
		return
	}
	if final.State.IsTerminal() {
		// Cancelled mid-flight; honour that.
		return
	}

	switch {
	case errors.Is(err, context.Canceled):
		next, _ := final.Transition(run.StateCancelled, r.Clock.Now().UTC())
		next.Error = "cancelled"
		_ = r.Registry.Update(bookkeeping, next)
	case err != nil:
		next, _ := final.Transition(run.StateFailed, r.Clock.Now().UTC())
		next.Error = err.Error()
		_ = r.Registry.Update(bookkeeping, next)
	default:
		next, _ := final.Transition(run.StateDone, r.Clock.Now().UTC())
		next.Result = result
		_ = r.Registry.Update(bookkeeping, next)
	}
}
