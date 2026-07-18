// Package sys holds the trivial production implementations of the ambient
// ports — a wall-clock Clock and a UUIDv4 IDGen — kept behind interfaces so the
// use case stays deterministic under test.
package sys

import (
	"time"

	"github.com/google/uuid"
)

// Clock is the wall-clock ports.Clock.
type Clock struct{}

func (Clock) Now() time.Time { return time.Now().UTC() }

// IDGen mints UUIDv4 job ids.
type IDGen struct{}

func (IDGen) NewID() string { return uuid.NewString() }
