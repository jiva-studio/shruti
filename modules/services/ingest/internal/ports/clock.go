package ports

import "time"

// Clock reports wall-clock time, so a use case can be driven by a fixed one.
type Clock interface {
	Now() time.Time
}

// SystemClock reads the machine clock.
type SystemClock struct{}

// Now returns the current time.
func (SystemClock) Now() time.Time { return time.Now() }
