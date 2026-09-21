package runner

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/run"
	systemclock "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/clock"
	memruns "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/runregistry/memory"
)

// waitForState polls until the run reaches expected (or fails the test
// after a generous timeout). Real-time tests that race goroutines need
// a polling helper; the alternative — sleeping fixed durations — is
// flakier under CI load.
func waitForState(t *testing.T, reg *memruns.Registry, runID string, expected run.State) run.Run {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r, err := reg.Get(t.Context(), runID)
		if err != nil {
			t.Fatalf("get %s: %v", runID, err)
		}
		if r.State == expected {
			return r
		}
		time.Sleep(5 * time.Millisecond)
	}
	r, _ := reg.Get(t.Context(), runID)
	t.Fatalf("expected state=%q, got %q (run=%+v)", expected, r.State, r)
	return r
}

// TestSubmitDoneFlow: happy path — submit, work runs, run lands in done
// with the work's result attached.
func TestSubmitDoneFlow(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	runID, err := r.Submit(t.Context(), Spec{
		Kind: run.KindPipeline,
		WorkFn: func(_ context.Context, _ ProgressFn) (json.RawMessage, error) {
			return json.RawMessage(`{"hello":"world"}`), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	got := waitForState(t, reg, runID, run.StateDone)
	if string(got.Result) != `{"hello":"world"}` {
		t.Errorf("Result = %s, want hello=world", got.Result)
	}
	if got.FinishedAt.IsZero() {
		t.Error("FinishedAt not set on terminal")
	}
}

// TestSubmitFailedFlow: WorkFn returns a non-cancellation error → the
// run lands in failed with Error populated.
func TestSubmitFailedFlow(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	runID, err := r.Submit(t.Context(), Spec{
		Kind: run.Kind("audio_normalize"), // opaque text after v2 — per-track tools don't run async anymore
		WorkFn: func(_ context.Context, _ ProgressFn) (json.RawMessage, error) {
			return nil, errors.New("synthetic boom")
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	got := waitForState(t, reg, runID, run.StateFailed)
	if got.Error != "synthetic boom" {
		t.Errorf("Error = %q, want %q", got.Error, "synthetic boom")
	}
}

// TestSubmitProgressTicks: WorkFn pushes progress; the registry sees the
// last update by the time the run terminates.
func TestSubmitProgressTicks(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	runID, err := r.Submit(t.Context(), Spec{
		Kind: run.KindPipeline,
		Init: run.Run{Progress: run.Progress{FilesTotal: 3}},
		WorkFn: func(_ context.Context, report ProgressFn) (json.RawMessage, error) {
			for i := 1; i <= 3; i++ {
				report(run.Progress{FilesTotal: 3, FilesDone: i})
				time.Sleep(2 * time.Millisecond)
			}
			return json.RawMessage("{}"), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := waitForState(t, reg, runID, run.StateDone)
	if got.Progress.FilesDone != 3 || got.Progress.FilesTotal != 3 {
		t.Errorf("Progress = %+v, want files_done=3 files_total=3", got.Progress)
	}
}

// TestCancelMidFlightWins: Cancel hit while WorkFn is mid-run → the
// run lands in cancelled, the registry's Cancel transition wins over
// the work's eventual return value.
func TestCancelMidFlightWins(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	gate := make(chan struct{})
	released := atomic.Bool{}
	runID, err := r.Submit(t.Context(), Spec{
		Kind:        run.KindPipeline,
		Cancellable: true,
		WorkFn: func(workCtx context.Context, _ ProgressFn) (json.RawMessage, error) {
			<-gate
			released.Store(true)
			// Even if WorkFn returns success after cancel, the runner
			// must respect the already-terminal state in the registry.
			select {
			case <-workCtx.Done():
				return nil, workCtx.Err()
			default:
				return json.RawMessage(`{"would-have-been":"ok"}`), nil
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Wait for it to enter running, then cancel.
	waitForState(t, reg, runID, run.StateRunning)
	if err := reg.Cancel(t.Context(), runID); err != nil {
		t.Fatal(err)
	}
	close(gate)

	got := waitForState(t, reg, runID, run.StateCancelled)
	if got.State != run.StateCancelled {
		t.Errorf("state = %q, want cancelled", got.State)
	}
	// State flips in registry the moment Cancel returns, but the
	// goroutine is still blocked on <-gate at that point. Give it a
	// moment to drain after close(gate) before asserting.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) && !released.Load() {
		time.Sleep(2 * time.Millisecond)
	}
	if !released.Load() {
		t.Error("gate not released — work goroutine deadlocked")
	}
}

// TestPanicInWorkLandsAsFailed: a panic inside WorkFn must not strand
// the run as 'running'. The runner recovers, marks failed, includes
// the panic in Error.
func TestPanicInWorkLandsAsFailed(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	runID, err := r.Submit(t.Context(), Spec{
		Kind: run.KindPublish,
		WorkFn: func(_ context.Context, _ ProgressFn) (json.RawMessage, error) {
			panic("synthetic panic")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := waitForState(t, reg, runID, run.StateFailed)
	if got.Error == "" {
		t.Error("Error is empty after panic recovery")
	}
}

// TestParallelRunsKeepDistinctIDs: two runs submitted back-to-back have
// different ids and don't blend into each other's state.
func TestParallelRunsKeepDistinctIDs(t *testing.T) {
	reg := memruns.New()
	r := New(reg, systemclock.New())

	a, _ := r.Submit(t.Context(), Spec{
		Kind: run.KindPipeline,
		WorkFn: func(_ context.Context, _ ProgressFn) (json.RawMessage, error) {
			return json.RawMessage(`{"who":"a"}`), nil
		},
	})
	b, _ := r.Submit(t.Context(), Spec{
		Kind: run.KindPipeline,
		WorkFn: func(_ context.Context, _ ProgressFn) (json.RawMessage, error) {
			return json.RawMessage(`{"who":"b"}`), nil
		},
	})
	if a == b {
		t.Fatalf("ids collided: %q == %q", a, b)
	}
	gotA := waitForState(t, reg, a, run.StateDone)
	gotB := waitForState(t, reg, b, run.StateDone)
	if string(gotA.Result) != `{"who":"a"}` {
		t.Errorf("a.Result = %s", gotA.Result)
	}
	if string(gotB.Result) != `{"who":"b"}` {
		t.Errorf("b.Result = %s", gotB.Result)
	}
}
