// Package gatefixtureuntil is a known violation: the application layer reads
// the wall clock through time.Until.
package gatefixtureuntil

import "time"

// Fixture reports how long remains until a deadline by the ambient clock.
func Fixture(deadline time.Time) time.Duration {
	return time.Until(deadline)
}
