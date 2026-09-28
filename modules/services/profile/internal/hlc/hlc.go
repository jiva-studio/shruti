// Package hlc derives the server-side Hybrid Logical Clock stamps for the
// server-authored write path.
//
// The client Push path mints an HLC on the device (wire format
// `<physical_ms:15>:<counter:5>:<device_id>`, compared lexicographically). The
// server-authored path (Service.ApplyServerChange) needs its own stamps in the
// SAME wire format so the shared `hlc` text column stays order-comparable
// across client and server writes.
//
// Server stamps are DETERMINISTIC in their source (an event id, a lifecycle
// rank, or the terminal constant) rather than freshly minted on each call: the
// same event always maps to the same hlc, so a redelivered broker message is
// at or below the document's highest stamp and the server writes nothing. A
// wall-clock stamp would make every redelivery look newer.
//
// Every stamp is fixed-width, so byte-wise string order is clock order; the
// store relies on this to pick a server-owned document's master with
// ORDER BY hlc COLLATE "C".
//
// The node id is fixed to "server:orchestrator".
package hlc

import (
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
)

// ServerNodeID is the device_id every server-authored change is stamped with.
// It doubles as the change-log device_id so server writes are attributable and
// distinguishable from any real device.
const ServerNodeID = "server:orchestrator"

// Fixed serialization widths — MUST match the TS side (@lib/domain/sync/hlc)
// so lexicographic comparison of the text column yields the same order both
// clients and server agree on.
const (
	physicalDigits = 15
	counterDigits  = 5
	// counterMod bounds the counter to the 5-digit field; physicalMod bounds
	// the physical component to the 15-digit field so hashed fallbacks stay
	// width-correct.
	counterMod  = 100000
	physicalMod = 1_000_000_000_000_000
)

// Clock derives server-node HLC stamps. Stamps are a pure function of the
// event id, so the Clock is stateless and safe for concurrent use.
type Clock struct{ nodeID string }

// NewClock returns a Clock for the fixed server node.
func NewClock() *Clock { return &Clock{nodeID: ServerNodeID} }

// Deterministic maps an event idempotency key to a server HLC. The SAME
// eventID always yields the SAME stamp, so a redelivered server event writes
// nothing.
//
// A Redis-Streams id ("<millis>-<seq>") or a bare integer is decoded straight
// into the physical/counter fields, so broker order is preserved as hlc order —
// the correct total order for a server-owned, single-writer collection. Any
// other token is hashed deterministically (still idempotent, but not
// order-preserving) as a safety net for non-stream callers.
func (c *Clock) Deterministic(eventID string) string {
	phys, ctr := decodeEventID(eventID)
	return format(phys, ctr, c.nodeID)
}

// Terminal returns the maximal server HLC (physical filled to the 15-digit
// field, counter 0). It stamps a MONOTONIC TERMINAL flip — a server-authored
// transition that must win last-writer-wins over every ordinary event on the
// same doc regardless of arrival order (e.g. the publish-service's
// origin='published' flip beating the track.ready row). It is a constant, so a
// redelivered terminal event writes nothing.
//
// Caveat: nothing sorts ABOVE a terminal stamp except a higher counter at the
// same physical. Any write that must supersede it (a library removal after a
// publish, or a repair row on a published doc) has to stamp physicalMod-1 with
// counter > 0; see Successor.
func (c *Clock) Terminal() string {
	return format(physicalMod-1, 0, c.nodeID)
}

// lifecycleRankStride is the per-generation physical block a ranked stamp
// occupies. It bounds the rank field (queued..removed = 1..4), so generation g
// owns physical [g*stride, g*stride+stride) and generation g+1 sorts strictly
// above every rank of generation g. Ample headroom below Terminal.
const lifecycleRankStride = 16

// Ranked stamps a server HLC from a lifecycle RANK within a job GENERATION,
// rather than an event id. A library membership advances through ordered states
// — queued < processing < ready|failed — with a promotion flip above all of them
// (see Terminal). Encoding generation*stride+rank as the physical field makes the
// higher state deterministically win on the server, which appends a change only
// when its stamp is above the document's highest one. Installed clients do NOT
// compare hlcs for library_items: they apply pulled rows in global_seq order and
// take each one wholesale, so that server-side gate is what keeps a late or
// redelivered lower state from reaching them. The same (generation, rank) always
// yields the same stamp, so a redelivery is a no-op.
//
// The generation lifts a RE-RUN of the same membership (a user-initiated retry of
// a dead-lettered job) above the prior run's terminal stamp: without it a retry's
// ready|failed (rank 3) would tie the earlier failed (rank 3) and collide away on
// the UNIQUE index, leaving the card stuck on the dead state. Generation 0 is the
// original run, so a never-restarted job stamps exactly as before. Stamps MUST
// stay below Terminal (physicalMod-1) so a publish flip supersedes every state.
//
// Sound ONLY for a server-owned, pull-only collection (library_items): no client
// ever mints a millisecond-physical stamp on the same doc that a tiny
// rank-physical would spuriously lose to.
func (c *Clock) Ranked(generation, rank int) string {
	p := int64(generation)*lifecycleRankStride + int64(rank)
	if p < 0 {
		p = 0
	}
	return format(p%physicalMod, 0, c.nodeID)
}

// decodeEventID extracts (physical, counter) from an event id. "<a>-<b>" (a
// Redis-Streams id) and a bare non-negative integer decode directly and
// preserve order; anything else falls back to a stable 64-bit hash split across
// the two fields.
func decodeEventID(eventID string) (phys, ctr int64) {
	a, b, hasDash := strings.Cut(eventID, "-")
	if p, err := strconv.ParseInt(a, 10, 64); err == nil && p >= 0 {
		if !hasDash {
			return p % physicalMod, 0
		}
		if q, err := strconv.ParseInt(b, 10, 64); err == nil && q >= 0 {
			return p % physicalMod, q % counterMod
		}
	}
	// Non-numeric token: hash deterministically so redelivery still collides.
	h := fnv.New64a()
	_, _ = h.Write([]byte(eventID))
	sum := int64(h.Sum64() & 0x7fffffffffffffff)
	return sum % physicalMod, sum % counterMod
}

// Successor returns the smallest stamp strictly above s on the same node: the
// same physical with the counter bumped by one. Ranked and Terminal stamps
// carry counter 0, so the successor of a ranked stamp sorts above that state
// and below the next rank, and the successor of Terminal (physicalMod-1,
// counter 1) is above every stamp the server mints.
func Successor(s string) (string, error) {
	physStr, rest, ok := strings.Cut(s, ":")
	if !ok {
		return "", fmt.Errorf("hlc %q: missing counter", s)
	}
	ctrStr, node, ok := strings.Cut(rest, ":")
	if !ok || node == "" {
		return "", fmt.Errorf("hlc %q: missing node id", s)
	}
	if len(physStr) != physicalDigits || len(ctrStr) != counterDigits {
		return "", fmt.Errorf("hlc %q: not fixed-width", s)
	}
	phys, err := strconv.ParseInt(physStr, 10, 64)
	if err != nil || phys < 0 {
		return "", fmt.Errorf("hlc %q: bad physical", s)
	}
	ctr, err := strconv.ParseInt(ctrStr, 10, 64)
	if err != nil || ctr < 0 {
		return "", fmt.Errorf("hlc %q: bad counter", s)
	}
	if ctr+1 >= counterMod {
		return "", fmt.Errorf("hlc %q: counter exhausted", s)
	}
	return format(phys, ctr+1, node), nil
}

// format serializes to the zero-padded wire string. Kept byte-for-byte
// compatible with the TS hlcToString so string comparison is order-preserving.
func format(phys, ctr int64, nodeID string) string {
	return fmt.Sprintf("%0*d:%0*d:%s", physicalDigits, phys, counterDigits, ctr, nodeID)
}
