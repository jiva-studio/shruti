package sqliteregistry

import (
	"errors"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/runregistry"
)

type counterMinter struct{ n atomic.Int64 }

func (m *counterMinter) MintTail() string { return strconv.FormatInt(m.n.Add(1), 10) }

func newReg(t *testing.T) (*Registry, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "runs.db")
	r, err := NewWithMinter(t.Context(), path, &counterMinter{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r, path
}

func TestSubmitMintsIDWhenEmpty(t *testing.T) {
	reg, _ := newReg(t)
	r, err := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	if err != nil {
		t.Fatal(err)
	}
	if r.ID == "" {
		t.Fatal("Id not minted")
	}
	if r.State != run.StateQueued {
		t.Errorf("State = %q, want queued", r.State)
	}
}

func TestSubmitKeepsCallerID(t *testing.T) {
	reg, _ := newReg(t)
	r, _ := reg.Submit(t.Context(), run.Run{ID: "fixed", Kind: run.KindPublish})
	if r.ID != "fixed" {
		t.Errorf("Id = %q, want fixed", r.ID)
	}
}

func TestGetUnknownIsErrNotFound(t *testing.T) {
	reg, _ := newReg(t)
	_, err := reg.Get(t.Context(), "nope")
	if !errors.Is(err, runregistry.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestUpdateRefusesTerminal(t *testing.T) {
	reg, _ := newReg(t)
	r, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	r2, _ := r.Transition(run.StateRunning, time.Now().UTC())
	if err := reg.Update(t.Context(), r2); err != nil {
		t.Fatal(err)
	}
	r3, _ := r2.Transition(run.StateDone, time.Now().UTC())
	if err := reg.Update(t.Context(), r3); err != nil {
		t.Fatal(err)
	}
	if err := reg.Update(t.Context(), r3); !errors.Is(err, runregistry.ErrTerminal) {
		t.Fatalf("err = %v, want ErrTerminal", err)
	}
}

func TestCancelInvokesCancelFunc(t *testing.T) {
	reg, _ := newReg(t)
	r, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	called := atomic.Bool{}
	if err := reg.SetCancelFunc(r.ID, func() { called.Store(true) }); err != nil {
		t.Fatal(err)
	}
	if err := reg.Cancel(t.Context(), r.ID); err != nil {
		t.Fatal(err)
	}
	if !called.Load() {
		t.Fatal("cancel func not invoked")
	}
	got, _ := reg.Get(t.Context(), r.ID)
	if got.State != run.StateCancelled {
		t.Errorf("State = %q, want cancelled", got.State)
	}
}

func TestCancelTerminalIsIdempotent(t *testing.T) {
	reg, _ := newReg(t)
	r, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	rRun, _ := r.Transition(run.StateRunning, time.Now().UTC())
	_ = reg.Update(t.Context(), rRun)
	rDone, _ := rRun.Transition(run.StateDone, time.Now().UTC())
	_ = reg.Update(t.Context(), rDone)
	if err := reg.Cancel(t.Context(), r.ID); err != nil {
		t.Fatalf("cancel of terminal must be a no-op, got %v", err)
	}
}

func TestListDefaultsActiveFirst(t *testing.T) {
	reg, _ := newReg(t)
	for i := 0; i < 3; i++ {
		_, _ = reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	}
	all, _ := reg.List(t.Context(), runregistry.ListOptions{})
	first := all[0]
	rRun, _ := first.Transition(run.StateRunning, time.Now().UTC())
	_ = reg.Update(t.Context(), rRun)
	rDone, _ := rRun.Transition(run.StateDone, time.Now().UTC())
	_ = reg.Update(t.Context(), rDone)

	got, err := reg.List(t.Context(), runregistry.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if got[i].State.IsTerminal() {
			t.Fatalf("position %d is terminal in default list: %+v", i, got[i])
		}
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runs.db")

	// First daemon: submit + finalize one run, leave one running.
	{
		reg, err := NewWithMinter(t.Context(), path, &counterMinter{})
		if err != nil {
			t.Fatal(err)
		}
		done, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPublish})
		dRun, _ := done.Transition(run.StateRunning, time.Now().UTC())
		_ = reg.Update(t.Context(), dRun)
		dDone, _ := dRun.Transition(run.StateDone, time.Now().UTC())
		dDone.Result = []byte(`{"files":42}`)
		_ = reg.Update(t.Context(), dDone)

		running, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
		rRun, _ := running.Transition(run.StateRunning, time.Now().UTC())
		_ = reg.Update(t.Context(), rRun)

		_ = reg.Close()
	}

	// Second daemon (simulating restart): the running row must be
	// reconciled to failed, error="daemon restart". The done row stays.
	reg2, err := NewWithMinter(t.Context(), path, &counterMinter{})
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	all, _ := reg2.List(t.Context(), runregistry.ListOptions{})
	if len(all) != 2 {
		t.Fatalf("want 2 runs after reload, got %d", len(all))
	}
	var doneCount, failedCount int
	for _, r := range all {
		switch r.State {
		case run.StateDone:
			doneCount++
			if string(r.Result) != `{"files":42}` {
				t.Errorf("result lost: %s", r.Result)
			}
		case run.StateFailed:
			failedCount++
			if r.Error != "daemon restart" {
				t.Errorf("expected restart error, got %q", r.Error)
			}
			if r.FinishedAt.IsZero() {
				t.Errorf("expected finished_at populated on reconciled row")
			}
		default:
			t.Errorf("unexpected state %q", r.State)
		}
	}
	if doneCount != 1 || failedCount != 1 {
		t.Errorf("want 1 done + 1 failed, got %d/%d", doneCount, failedCount)
	}
}

func TestKindOpaqueAtSQLBoundary(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runs.db")

	// Persist a row whose Kind is an arbitrary string (simulates a kind
	// whose constant gets dropped between daemon versions).
	{
		reg, err := NewWithMinter(t.Context(), path, &counterMinter{})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = reg.Submit(t.Context(), run.Run{Kind: run.Kind("mystery_kind_v1")})
		_ = reg.Close()
	}

	// Reopen — the row must load cleanly and surface the original kind
	// string verbatim. No enum validation at the SQL boundary.
	reg, err := NewWithMinter(t.Context(), path, &counterMinter{})
	if err != nil {
		t.Fatalf("reload with unknown kind failed: %v", err)
	}
	defer reg.Close()
	all, _ := reg.List(t.Context(), runregistry.ListOptions{})
	if len(all) != 1 {
		t.Fatalf("want 1 row, got %d", len(all))
	}
	if all[0].Kind != "mystery_kind_v1" {
		t.Errorf("Kind not preserved: got %q", all[0].Kind)
	}
}
