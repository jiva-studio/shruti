package hlc

import (
	"strings"
	"testing"
)

// A minted stamp has the fixed wire shape and the server node id.
func TestNextFormat(t *testing.T) {
	c := newClockAt(func() int64 { return 1718000000000 })
	got := c.Next("")
	parts := strings.SplitN(got, ":", 3)
	if len(parts) != 3 {
		t.Fatalf("want 3 colon-separated parts, got %q", got)
	}
	if len(parts[0]) != physicalDigits {
		t.Errorf("physical width: want %d, got %d (%q)", physicalDigits, len(parts[0]), parts[0])
	}
	if len(parts[1]) != counterDigits {
		t.Errorf("counter width: want %d, got %d (%q)", counterDigits, len(parts[1]), parts[1])
	}
	if parts[2] != ServerNodeID {
		t.Errorf("node id: want %q, got %q", ServerNodeID, parts[2])
	}
}

// Successive stamps at a frozen wall clock stay strictly increasing (counter
// bumps) and lexicographically ordered.
func TestNextMonotonicSameMillis(t *testing.T) {
	c := newClockAt(func() int64 { return 1718000000000 })
	prev := c.Next("")
	for i := 0; i < 5; i++ {
		cur := c.Next("")
		if cur <= prev {
			t.Fatalf("stamp %d not strictly greater: %q <= %q", i, cur, prev)
		}
		prev = cur
	}
}

// A stamp fast-forwards strictly past a base whose physical time is in the
// future relative to the wall clock — the "newer than the client master" rule.
func TestNextFastForwardsPastFutureBase(t *testing.T) {
	c := newClockAt(func() int64 { return 1000 })
	// base physical is far ahead of the wall clock.
	base := format(9_000_000_000_000, 7, "device-abc")
	got := c.Next(base)
	if got <= base {
		t.Fatalf("stamp must be newer than base: %q <= %q", got, base)
	}
	// Same-millis base → counter must exceed the base counter.
	p, ctr, ok := parse(got)
	if !ok {
		t.Fatalf("minted stamp does not parse: %q", got)
	}
	if p != 9_000_000_000_000 || ctr != 8 {
		t.Fatalf("want physical=9e12 counter=8, got physical=%d counter=%d", p, ctr)
	}
}

// An unparseable base is treated as "no base" rather than panicking.
func TestNextToleratesGarbageBase(t *testing.T) {
	c := newClockAt(func() int64 { return 1718000000000 })
	got := c.Next("not-an-hlc")
	if got == "" {
		t.Fatal("expected a stamp even with a garbage base")
	}
}
