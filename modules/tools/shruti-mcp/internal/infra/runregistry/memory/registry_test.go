package memory

import (
	"context"
	"errors"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/run"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/runregistry"
)

type counterMinter struct{ n atomic.Int64 }

func (m *counterMinter) MintTail() string { return strconv.FormatInt(m.n.Add(1), 10) }

func TestSubmitMintsIDWhenEmpty(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, err := reg.Submit(context.Background(), run.Run{Kind: run.KindPipeline})
	if err != nil {
		t.Fatal(err)
	}
	if r.Id == "" {
		t.Fatal("Id not minted")
	}
	if r.State != run.StateQueued {
		t.Errorf("State = %q, want queued", r.State)
	}
}

func TestSubmitKeepsCallerID(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(context.Background(), run.Run{Id: "fixed", Kind: run.KindPublish})
	if r.Id != "fixed" {
		t.Errorf("Id = %q, want fixed", r.Id)
	}
}

func TestGetUnknownIsErrNotFound(t *testing.T) {
	reg := New()
	_, err := reg.Get(context.Background(), "nope")
	if !errors.Is(err, runregistry.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestUpdateRefusesTerminal(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(context.Background(), run.Run{Kind: run.KindPipeline})
	// transition to running, then to done — terminal.
	r2, _ := r.Transition(run.StateRunning)
	if err := reg.Update(context.Background(), r2); err != nil {
		t.Fatal(err)
	}
	r3, _ := r2.Transition(run.StateDone)
	if err := reg.Update(context.Background(), r3); err != nil {
		t.Fatal(err)
	}
	// Now any further update must be rejected.
	if err := reg.Update(context.Background(), r3); !errors.Is(err, runregistry.ErrTerminal) {
		t.Fatalf("err = %v, want ErrTerminal", err)
	}
}

func TestCancelInvokesCancelFunc(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(context.Background(), run.Run{Kind: run.KindPipeline})
	called := atomic.Bool{}
	if err := reg.SetCancelFunc(r.Id, func() { called.Store(true) }); err != nil {
		t.Fatal(err)
	}
	if err := reg.Cancel(context.Background(), r.Id); err != nil {
		t.Fatal(err)
	}
	if !called.Load() {
		t.Fatal("cancel func not invoked")
	}
	got, _ := reg.Get(context.Background(), r.Id)
	if got.State != run.StateCancelled {
		t.Errorf("State = %q, want cancelled", got.State)
	}
}

func TestCancelTerminalIsIdempotent(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	r, _ := reg.Submit(context.Background(), run.Run{Kind: run.KindPipeline})
	rRun, _ := r.Transition(run.StateRunning)
	_ = reg.Update(context.Background(), rRun)
	rDone, _ := rRun.Transition(run.StateDone)
	_ = reg.Update(context.Background(), rDone)
	if err := reg.Cancel(context.Background(), r.Id); err != nil {
		t.Fatalf("cancel of terminal must be a no-op, got %v", err)
	}
}

func TestListDefaultsActiveFirst(t *testing.T) {
	reg := NewWithMinter(&counterMinter{})
	for i := 0; i < 3; i++ {
		_, _ = reg.Submit(context.Background(), run.Run{Kind: run.KindPipeline})
	}
	// Mark one of them done so we have a mix of active and terminal.
	all, _ := reg.List(context.Background(), runregistry.ListOptions{})
	first := all[0]
	rRun, _ := first.Transition(run.StateRunning)
	_ = reg.Update(context.Background(), rRun)
	rDone, _ := rRun.Transition(run.StateDone)
	_ = reg.Update(context.Background(), rDone)

	got, err := reg.List(context.Background(), runregistry.ListOptions{})
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
