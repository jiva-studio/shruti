// Package gatefixturerand is a known violation: the application layer draws
// from the unseeded global source.
package gatefixturerand

import "math/rand"

// Fixture picks an index nobody can reproduce.
func Fixture(n int) int {
	return rand.Intn(n)
}
