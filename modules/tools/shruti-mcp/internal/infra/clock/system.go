// Package systemclock reads the machine's wall clock.
package systemclock

import "time"

// Clock implements ports/clock.Clock against time.Now.
type Clock struct{}

func New() Clock { return Clock{} }

func (Clock) Now() time.Time { return time.Now() }
