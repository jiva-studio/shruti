// Package hlc derives the server-side Hybrid Logical Clock stamps for the
// server-authored write path.
//
// The client Push path mints an HLC on the device (wire format
// `<physical_ms:15>:<counter:5>:<device_id>`, compared lexicographically). The
// server-authored path (library_items lifecycle and publish events) needs its
// own stamps in the SAME wire format.
//
// Server stamps are DETERMINISTIC in their source (a lifecycle rank or the
// terminal constant) rather than freshly minted on each call: the
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
	// the physical component to the 15-digit field.
	counterMod  = 100000
	physicalMod = 1_000_000_000_000_000
)

// Clock derives server-node HLC stamps. Stamps are a pure function of their
// inputs, so the Clock is stateless and safe for concurrent use.
type Clock struct{ nodeID string }

// NewClock returns a Clock for the fixed server node.
func NewClock() *Clock { return &Clock{nodeID: ServerNodeID} }

// Terminal returns the maximal server HLC (physical filled to the 15-digit
// field, counter 0). It stamps a MONOTONIC TERMINAL flip — a server-authored
// transition that must win last-writer-wins over every ordinary event on the
// same doc regardless of arrival order (e.g. the publish-service's
// origin='published' flip beating the track.ready row). It is a constant, so a
// redelivered terminal event writes nothing.
//
// Nothing sorts above a terminal stamp except a higher counter at the same
// physical.
func (c *Clock) Terminal() string {
	return format(physicalMod-1, 0, c.nodeID)
}

// lifecycleRankStride is the per-generation physical block a ranked stamp
// occupies. It bounds the rank field (queued..removed = 1..4), so generation g
// owns physical [g*stride, g*stride+stride) and generation g+1 sorts strictly
// above every rank of generation g. Ample headroom below Terminal.
const lifecycleRankStride = 16

// Ranked stamps a server HLC from a lifecycle RANK within a job GENERATION. A
// library membership advances through ordered states
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
// a dead-lettered job) above the prior run's final state: without it a retry's
// ready|failed (rank 3) would tie the earlier failed (rank 3) and be dropped as
// not newer, leaving the card stuck on the dead state. Generation 0 is the
// original run. Stamps MUST
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

// format serializes to the zero-padded wire string. Kept byte-for-byte
// compatible with the TS hlcToString so string comparison is order-preserving.
func format(phys, ctr int64, nodeID string) string {
	return fmt.Sprintf("%0*d:%0*d:%s", physicalDigits, phys, counterDigits, ctr, nodeID)
}
