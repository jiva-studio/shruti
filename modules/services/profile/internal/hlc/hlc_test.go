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

// A terminal stamp wins last-writer-wins over EVERY ordinary stamp — an
// ms-based stream id AND a fnv-hashed non-numeric token (the track.ready
// "<jobID>:ready" case that a plain ms stamp would lose to). It is also stable
// so a redelivered publish collapses on the change-log UNIQUE. This locks in the
// origin='published' flip landing regardless of the ready row's hlc.
func TestTerminalWinsOverEveryOrdinaryStamp(t *testing.T) {
	c := NewClock()
	term := c.Terminal()
	if a, b := c.Terminal(), c.Terminal(); a != b {
		t.Fatalf("terminal stamp not stable: %q != %q", a, b)
	}
	if parts := strings.SplitN(term, ":", 3); len(parts) != 3 ||
		len(parts[0]) != physicalDigits || len(parts[1]) != counterDigits || parts[2] != ServerNodeID {
		t.Fatalf("terminal stamp malformed: %q", term)
	}
	for _, id := range []string{
		"1718000000000-0",          // ordinary ms-seq stream id
		"9999999999999-99999",      // a far-future stream id
		"1b671a64-40d5-491e:ready", // a fnv-hashed non-numeric track.ready id
		"not-a-stream-id",
		"42",
	} {
		if ordinary := c.Deterministic(id); !(term > ordinary) {
			t.Errorf("terminal %q must sort after ordinary %q (from %q)", term, ordinary, id)
		}
	}
}

// Ranked stamps are stable, strictly ordered by rank, and all sort below a
// Terminal stamp — the invariant the library_items lifecycle LWW relies on
// (queued < processing < ready|failed < published).
func TestRankedOrderingAndTerminalDominance(t *testing.T) {
	c := NewClock()
	// Stable for the same (generation, rank) (idempotent redelivery collides on hlc).
	if a, b := c.Ranked(0, 2), c.Ranked(0, 2); a != b {
		t.Fatalf("ranked stamp not stable: %q != %q", a, b)
	}
	// Well-formed wire shape.
	if parts := strings.SplitN(c.Ranked(0, 3), ":", 3); len(parts) != 3 ||
		len(parts[0]) != physicalDigits || len(parts[1]) != counterDigits || parts[2] != ServerNodeID {
		t.Fatalf("ranked stamp malformed: %q", c.Ranked(0, 3))
	}
	// Strictly increasing across the lifecycle ranks, and every rank below Terminal.
	term := c.Terminal()
	prev := c.Ranked(0, 0)
	for rank := 1; rank <= 4; rank++ {
		cur := c.Ranked(0, rank)
		if !(cur > prev) {
			t.Errorf("rank %d stamp %q not greater than rank %d stamp %q", rank, cur, rank-1, prev)
		}
		if !(term > cur) {
			t.Errorf("terminal %q must sort after rank %d stamp %q", term, rank, cur)
		}
		prev = cur
	}
}

// A higher generation sorts strictly above EVERY rank of the lower generation —
// so a retry's queued (gen 1, rank 1) beats the prior run's failed (gen 0, rank
// 3), the invariant that lets a dead-lettered card recover in place. Every
// generation still sorts below Terminal.
func TestRankedGenerationDominatesPriorRun(t *testing.T) {
	c := NewClock()
	term := c.Terminal()
	priorFailed := c.Ranked(0, 3)
	for rank := 1; rank <= 4; rank++ {
		retry := c.Ranked(1, rank)
		if !(retry > priorFailed) {
			t.Errorf("gen 1 rank %d stamp %q must beat gen 0 failed %q", rank, retry, priorFailed)
		}
		if !(term > retry) {
			t.Errorf("terminal %q must sort after gen 1 rank %d stamp %q", term, rank, retry)
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
