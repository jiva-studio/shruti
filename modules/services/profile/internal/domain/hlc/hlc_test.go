package hlc

import (
	"math/rand/v2"
	"strconv"
	"strings"
	"testing"
)

// Ranked stamps are stable, strictly ordered by rank, and all sort below a
// Terminal stamp — the invariant the library_items lifecycle LWW relies on
// (queued < processing < ready|failed < published).
func TestRankedOrderingAndTerminalDominance(t *testing.T) {
	c := NewClock()
	// Stable for the same (generation, rank), so a redelivery is not newer.
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
// every constructor and random values across each field's
// full range, including the extremes.
func TestServerStampsStringOrderIsClockOrder(t *testing.T) {
	c := NewClock()
	stamps := []string{
		c.Terminal(),
		c.Ranked(0, 0), c.Ranked(0, 1), c.Ranked(0, 4), c.Ranked(1, 1), c.Ranked(1<<40, 3),
		format(0, 0, ServerNodeID), format(9, counterMod-1, ServerNodeID), format(10, 0, ServerNodeID),
		format(physicalMod-1, counterMod-2, ServerNodeID),
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		stamps = append(stamps,
			c.Ranked(rng.IntN(1_000_000), rng.IntN(lifecycleRankStride)),
			format(rng.Int64N(physicalMod), rng.Int64N(counterMod), ServerNodeID),
			format(rng.Int64N(1000), rng.Int64N(10), ServerNodeID),
		)
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
