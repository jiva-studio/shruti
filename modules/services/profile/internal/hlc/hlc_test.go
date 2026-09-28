package hlc

import (
	"fmt"
	"math/rand/v2"
	"strconv"
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

// stampTuple parses a server stamp back into its numeric clock tuple.
func stampTuple(t *testing.T, s string) (phys, ctr int64) {
	t.Helper()
	parts := strings.SplitN(s, ":", 3)
	if len(parts) != 3 || len(parts[0]) != physicalDigits || len(parts[1]) != counterDigits || parts[2] != ServerNodeID {
		t.Fatalf("stamp %q is not fixed-width", s)
	}
	p, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		t.Fatalf("physical of %q: %v", s, err)
	}
	c, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		t.Fatalf("counter of %q: %v", s, err)
	}
	return p, c
}

// Every server stamp is fixed-width, so byte-wise string order equals numeric
// (physical, counter) order — the property ORDER BY hlc COLLATE "C" relies on
// to pick a server-owned document's master. Checked pairwise over stamps from
// every constructor, including the extremes of each field.
func TestServerStampsStringOrderIsClockOrder(t *testing.T) {
	c := NewClock()
	stamps := []string{
		c.Terminal(),
		c.Ranked(0, 0), c.Ranked(0, 1), c.Ranked(0, 4), c.Ranked(1, 1), c.Ranked(1_000_000, 15),
		c.Deterministic("0"), c.Deterministic("9-99999"), c.Deterministic("10-0"),
		c.Deterministic("999999999999999-99999"), c.Deterministic("evt-abc"),
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		stamps = append(stamps,
			c.Ranked(rng.IntN(1_000_000), rng.IntN(lifecycleRankStride)),
			c.Deterministic(fmt.Sprintf("%d-%d", rng.Int64N(physicalMod), rng.Int64N(counterMod))),
			c.Deterministic(strconv.FormatInt(rng.Int64N(1<<40), 10)),
		)
	}
	for _, s := range stamps {
		if next, err := Successor(s); err == nil {
			stamps = append(stamps, next)
		}
	}
	for _, a := range stamps {
		pa, ca := stampTuple(t, a)
		for _, b := range stamps {
			pb, cb := stampTuple(t, b)
			numLess := pa < pb || (pa == pb && ca < cb)
			if (a < b) != numLess {
				t.Fatalf("string order disagrees with clock order: %q vs %q", a, b)
			}
		}
	}
}

// Successor sorts strictly above its input and below the next ranked state, and
// is the only way above Terminal: physicalMod-1 with counter 1.
func TestSuccessor(t *testing.T) {
	c := NewClock()
	next, err := Successor(c.Ranked(0, 3))
	if err != nil {
		t.Fatalf("successor of ranked: %v", err)
	}
	if next <= c.Ranked(0, 3) || next >= c.Ranked(0, 4) {
		t.Errorf("successor %q must sit between rank 3 and rank 4", next)
	}
	afterTerm, err := Successor(c.Terminal())
	if err != nil {
		t.Fatalf("successor of terminal: %v", err)
	}
	if want := "999999999999999:00001:" + ServerNodeID; afterTerm != want {
		t.Errorf("successor of terminal: want %q, got %q", want, afterTerm)
	}
	for _, bad := range []string{"", "1:2:x", "000000000000001:00000", "000000000000001:99999:" + ServerNodeID} {
		if _, err := Successor(bad); err == nil {
			t.Errorf("Successor(%q) must fail", bad)
		}
	}
}
