// Package clock is the process clock: the default the deterministic layers
// fall back to when nothing injected one. It is a leaf, not an adapter — the
// application takes its time through an injected `Now` field and reaches here
// only for the default.
package clock

import "time"

// Now is what this machine says the time is.
func Now() time.Time { return time.Now() }

// UTC is Now in the zone everything stored is written in.
func UTC() time.Time { return time.Now().UTC() }
