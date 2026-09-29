package domain

import "time"

// Run is one pass over an archive, and the record of what it cost.
type Run struct {
	ID             int64
	SourceID       *string
	DryRun         bool
	StartedAt      time.Time
	FinishedAt     *time.Time
	PagesFetched   int
	PagesUnchanged int
	ItemsFound     int
	ItemsNew       int
	ItemsChanged   int
	Failures       int
	Errors         map[string]int
	// Interrupted means the process died while this run was going — a deploy,
	// a restart, a crash. Its counters are whatever it had managed to record,
	// and there is no finish time because we never learned one.
	Interrupted bool
}
