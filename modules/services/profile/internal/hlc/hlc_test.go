package hlc

import (
	"strings"
	"testing"
)

// A derived stamp has the fixed wire shape and the server node id.
func TestDeterministicFormat(t *testing.T) {
	c := NewClock()
	got := c.Deterministic("1718000000000-0")
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

// The SAME event id always maps to the SAME stamp — the idempotency guarantee
// that makes a redelivered event collide on the change log's UNIQUE constraint.
func TestDeterministicStableForSameEvent(t *testing.T) {
	c := NewClock()
	for _, id := range []string{"1718000000000-0", "42", "evt-abc-def"} {
		if a, b := c.Deterministic(id), c.Deterministic(id); a != b {
			t.Errorf("stamp not stable for %q: %q != %q", id, a, b)
		}
	}
}

// A stream id ("<millis>-<seq>") decodes so that broker order is preserved as
// lexicographic hlc order — later events sort strictly after earlier ones.
func TestDeterministicStreamOrderPreserved(t *testing.T) {
	c := NewClock()
	ordered := []string{
		"1718000000000-0",
		"1718000000000-1",
		"1718000000001-0",
		"1718000000002-9",
	}
	for i := 1; i < len(ordered); i++ {
		prev, cur := c.Deterministic(ordered[i-1]), c.Deterministic(ordered[i])
		if cur <= prev {
			t.Fatalf("%q must sort after %q: %q <= %q", ordered[i], ordered[i-1], cur, prev)
		}
	}
}

// A non-stream token still produces a stable, well-formed stamp (hash fallback)
// so a misconfigured caller never crashes and redelivery is still idempotent.
func TestDeterministicHashFallback(t *testing.T) {
	c := NewClock()
	got := c.Deterministic("not-a-stream-id")
	if got == "" {
		t.Fatal("expected a stamp for an arbitrary token")
	}
	parts := strings.SplitN(got, ":", 3)
	if len(parts) != 3 || len(parts[0]) != physicalDigits || len(parts[1]) != counterDigits {
		t.Fatalf("hashed stamp is malformed: %q", got)
	}
}
