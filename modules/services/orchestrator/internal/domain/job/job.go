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

// Op is the operation a run performs; the worker dispatches on it.
const (
	OpIngest    = "ingest"
	OpTranslate = "translate"
)

// Job is the aggregate root — the source of truth persisted in
// orchestrator.jobs. Spec/Result are kind-specific JSON payloads.
type Job struct {
	ID   string
	Kind Kind
	// Op is the operation this run performs — the worker branches on it
	// ("ingest" | "translate"). Kind stays the broad scenario; Op the action.
	Op string
	// MembershipID links the run to the track_memberships projection it advances.
	// Multiple runs (ingest, then translate) share one membership_id per track.
	MembershipID string
	OwnerID      string // requesting user; empty for system jobs
	State        State
	Spec         []byte // kind-specific request (JSON)
	Result       []byte // terminal payload (JSON); nil until done
	Progress     []byte // kind-specific progress (JSON), poll-only; latest stage while running
	TrackID      string // content hash; empty until fetched
	Err          string
	Attempts     int
	// Generation counts re-runs of this job. 0 is the original run; a
	// user-initiated retry of a dead-lettered (failed) job increments it so the
	// re-run's track.events lifecycle stamps sort above the prior run's terminal
	// state (see the profile projection's rank-ordered hlc). Attempts stay
	// monotonic ACROSS generations so a stale result from a prior run is still
	// discarded by its attempt number alone.
	Generation int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// allowedTransitions encodes the state machine.
var allowedTransitions = map[State]map[State]bool{
	// queued may fail directly when a pre-flight check rejects it (e.g. the
	// PRO-tier re-verification fails before any work starts).
	StateQueued:  {StateRunning: true, StateCancelled: true, StateFailed: true},
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
