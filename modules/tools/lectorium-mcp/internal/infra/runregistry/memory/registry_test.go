package memory

import (
	"errors"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/run"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/runregistry"
)

type counterMinter struct{ n atomic.Int64 }

func (m *counterMinter) MintTail() string { return strconv.FormatInt(m.n.Add(1), 10) }

func TestSubmitMintsIDWhenEmpty(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
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
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(t.Context(), run.Run{ID: "fixed", Kind: run.KindPublish})
	if r.ID != "fixed" {
		t.Errorf("Id = %q, want fixed", r.ID)
	}
}

func TestGetUnknownIsErrNotFound(t *testing.T) {
	reg := New()
	_, err := reg.Get(t.Context(), "nope")
	if !errors.Is(err, runregistry.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestUpdateRefusesTerminal(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	// transition to running, then to done — terminal.
	r2, _ := r.Transition(run.StateRunning, time.Now().UTC())
	if err := reg.Update(t.Context(), r2); err != nil {
		t.Fatal(err)
	}
	r3, _ := r2.Transition(run.StateDone, time.Now().UTC())
	if err := reg.Update(t.Context(), r3); err != nil {
		t.Fatal(err)
	}
	// Now any further update must be rejected.
	if err := reg.Update(t.Context(), r3); !errors.Is(err, runregistry.ErrTerminal) {
		t.Fatalf("err = %v, want ErrTerminal", err)
	}
}

func TestCancelInvokesCancelFunc(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
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
	reg := NewWithMinter(&counterMinter{})
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
	reg := NewWithMinter(&counterMinter{})
	for i := 0; i < 3; i++ {
		_, _ = reg.Submit(t.Context(), run.Run{Kind: run.KindPipeline})
	}
	// Mark one of them done so we have a mix of active and terminal.
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
	// Active runs must come first; the done one is somewhere later.
	for i := 0; i < 2; i++ {
		if got[i].State.IsTerminal() {
			t.Fatalf("position %d is terminal in default list: %+v", i, got[i])
		}
	}
}
