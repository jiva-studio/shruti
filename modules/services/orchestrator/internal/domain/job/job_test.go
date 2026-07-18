package job

import "testing"

func TestTransitions(t *testing.T) {
	cases := []struct {
		from, to State
		ok       bool
	}{
		{StateQueued, StateRunning, true},
		{StateRunning, StateDone, true},
		{StateRunning, StateFailed, true},
		{StateFailed, StateQueued, true}, // retry
		{StateQueued, StateDone, false},  // must run first
		{StateDone, StateRunning, false}, // terminal
		{StateCancelled, StateQueued, false},
	}
	for _, c := range cases {
		j := &Job{State: c.from}
		err := j.To(c.to)
		if c.ok && err != nil {
			t.Errorf("%s -> %s: unexpected error %v", c.from, c.to, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s -> %s: expected error, got none", c.from, c.to)
		}
	}
}

func TestIsTerminal(t *testing.T) {
	for _, s := range []State{StateDone, StateFailed, StateCancelled} {
		if !s.IsTerminal() {
			t.Errorf("%s should be terminal", s)
		}
	}
	for _, s := range []State{StateQueued, StateRunning} {
		if s.IsTerminal() {
			t.Errorf("%s should not be terminal", s)
		}
	}
}
