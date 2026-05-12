package run

import "testing"

func TestNewIsQueued(t *testing.T) {
	r := New("01HABCD", KindPipeline)
	if r.State != StateQueued {
		t.Fatalf("New().State = %q, want queued", r.State)
	}
	if r.StartedAt.IsZero() {
		t.Fatal("New().StartedAt zero")
	}
	if !r.FinishedAt.IsZero() {
		t.Fatal("New().FinishedAt should be zero until terminal")
	}
}

func TestStateIsTerminal(t *testing.T) {
	cases := []struct {
		s    State
		want bool
	}{
		{StateQueued, false},
		{StateRunning, false},
		{StateDone, true},
		{StateFailed, true},
		{StateCancelled, true},
	}
	for _, c := range cases {
		if got := c.s.IsTerminal(); got != c.want {
			t.Errorf("%s.IsTerminal() = %v, want %v", c.s, got, c.want)
		}
	}
}

func TestTransitionAllowed(t *testing.T) {
	cases := []struct {
		from, to State
		ok       bool
	}{
		{StateQueued, StateRunning, true},
		{StateQueued, StateCancelled, true},
		{StateQueued, StateDone, false},
		{StateQueued, StateFailed, false},
		{StateRunning, StateDone, true},
		{StateRunning, StateFailed, true},
		{StateRunning, StateCancelled, true},
		{StateRunning, StateQueued, false},
		{StateDone, StateRunning, false},
		{StateFailed, StateRunning, false},
		{StateCancelled, StateRunning, false},
	}
	for _, c := range cases {
		r := Run{Id: "x", State: c.from}
		out, err := r.Transition(c.to)
		if c.ok && err != nil {
			t.Errorf("%s → %s rejected: %v", c.from, c.to, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s → %s should have been rejected", c.from, c.to)
		}
		if c.ok && c.to.IsTerminal() && out.FinishedAt.IsZero() {
			t.Errorf("%s → %s: FinishedAt not set on terminal transition", c.from, c.to)
		}
		if c.ok && !c.to.IsTerminal() && !out.FinishedAt.IsZero() {
			t.Errorf("%s → %s: FinishedAt set on non-terminal transition", c.from, c.to)
		}
	}
}

func TestTransitionDoesNotMutateInput(t *testing.T) {
	r := Run{Id: "x", State: StateQueued}
	out, err := r.Transition(StateRunning)
	if err != nil {
		t.Fatal(err)
	}
	if r.State != StateQueued {
		t.Errorf("input mutated: %s", r.State)
	}
	if out.State != StateRunning {
		t.Errorf("output not transitioned: %s", out.State)
	}
}
