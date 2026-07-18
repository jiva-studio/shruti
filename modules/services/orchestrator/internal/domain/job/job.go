// Package job is the orchestrator's generic core aggregate. It knows nothing
// about ingest specifically — `Kind` keeps it reusable for future orchestrated
// tasks; the kind-specific request/result live in the opaque Spec/Result.
package job

import (
	"fmt"
	"time"
)

// State is the job lifecycle. Terminal states are done, failed, cancelled.
type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateDone      State = "done"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
)

// IsTerminal reports whether no further transition is possible.
func (s State) IsTerminal() bool {
	switch s {
	case StateDone, StateFailed, StateCancelled:
		return true
	default:
		return false
	}
}

// Kind identifies the scenario. The first (and today only) kind is ingest.
type Kind string

const KindLibraryIngest Kind = "library_ingest"

// Job is the aggregate root — the source of truth persisted in
// orchestrator.jobs. Spec/Result are kind-specific JSON payloads.
type Job struct {
	ID        string
	Kind      Kind
	OwnerID   string // requesting user; empty for system jobs
	State     State
	Spec      []byte // kind-specific request (JSON)
	Result    []byte // terminal payload (JSON); nil until done
	TrackID   string // content hash; empty until fetched
	Err       string
	Attempts  int
	CreatedAt time.Time
	UpdatedAt time.Time
}

// allowedTransitions encodes the state machine.
var allowedTransitions = map[State]map[State]bool{
	StateQueued:  {StateRunning: true, StateCancelled: true},
	StateRunning: {StateDone: true, StateFailed: true, StateCancelled: true},
	// failed may be retried back into the queue by the worker until it
	// dead-letters (attempts cap enforced at the application layer).
	StateFailed: {StateQueued: true},
}

// To transitions the job to next, rejecting illegal moves.
func (j *Job) To(next State) error {
	if j.State == next {
		return nil
	}
	if !allowedTransitions[j.State][next] {
		return fmt.Errorf("illegal job transition %s -> %s", j.State, next)
	}
	j.State = next
	return nil
}
