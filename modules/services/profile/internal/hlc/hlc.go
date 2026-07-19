// Package hlc derives the server-side Hybrid Logical Clock stamps for the
// server-authored write path.
//
// The client Push path mints an HLC on the device (wire format
// `<physical_ms:15>:<counter:5>:<device_id>`, compared lexicographically). The
// server-authored path (Service.ApplyServerChange) needs its own stamps in the
// SAME wire format so the shared `hlc` text column stays order-comparable
// across client and server writes.
//
// Server stamps are DETERMINISTIC in the source event's idempotency key rather
// than freshly minted on each call: the same event id always maps to the same
// hlc, so a redelivered broker message collides on the change log's
// UNIQUE(user_id, collection, doc_id, hlc) and writes exactly one row. For a
// server-owned collection the server is the SOLE writer and events arrive in
// broker order, so ordering by the (monotonic) event id is the correct total
// order — there is no client master to leapfrog, and a wall-clock fast-forward
// (which mints a fresh, ever-newer stamp) would defeat the redelivery collision.
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
// eventID always yields the SAME stamp, so a redelivered server event collides
// on UNIQUE(user_id, collection, doc_id, hlc) and appends exactly one row.
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
// origin='published' flip beating an earlier track.ready row whose hlc is a
// high fnv-hash). It is a constant, so a redelivered terminal event collides on
// UNIQUE(user_id, collection, doc_id, hlc) and stays idempotent.
//
// Caveat: nothing sorts ABOVE a terminal stamp except a higher counter at the
// same physical. A future terminal event that must supersede this one (e.g. a
// library removal after a publish) has to stamp physicalMod-1 with counter > 0.
func (c *Clock) Terminal() string {
	return format(physicalMod-1, 0, c.nodeID)
}

// Ranked stamps a server HLC from a fixed lifecycle RANK rather than an event
// id. A library membership advances through ordered states — queued < processing
// < ready|failed — with a promotion flip above all of them (see Terminal).
// Encoding the rank as the physical field makes the higher state deterministically
// win last-writer-wins on BOTH the server projection and the client (which
// re-resolves state from the pulled change log by hlc), while staying idempotent:
// the same rank always yields the same stamp, so a redelivered event collides on
// UNIQUE(user_id, collection, doc_id, hlc) and appends exactly one row. Ranks MUST
// stay below Terminal (physicalMod-1) so a publish flip supersedes every state.
//
// Sound ONLY for a server-owned, pull-only collection (library_items): no client
// ever mints a millisecond-physical stamp on the same doc that a tiny
// rank-physical would spuriously lose to.
func (c *Clock) Ranked(rank int) string {
	p := int64(rank)
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

// format serializes to the zero-padded wire string. Kept byte-for-byte
// compatible with the TS hlcToString so string comparison is order-preserving.
func format(phys, ctr int64, nodeID string) string {
	return fmt.Sprintf("%0*d:%0*d:%s", physicalDigits, phys, counterDigits, ctr, nodeID)
}
