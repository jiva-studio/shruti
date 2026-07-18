// Package hlc is the server-side Hybrid Logical Clock generator for the
// server-authored write path.
//
// Today the only writer of the change log is the client Push path, where every
// change already carries an HLC minted on the device (see the TS
// @lib/domain/sync/hlc — wire format `<physical_ms:15>:<counter:5>:<device_id>`,
// compared lexicographically). The server-authored path (Service.ApplyServerChange)
// needs its OWN monotonic clock so a server-minted change on a document is
// deterministically NEWER than the client's current master for that document,
// and than any prior server write — under the same string comparison the
// `hlc` text column uses.
//
// The node id is fixed to "server:orchestrator". Strict newer-than is
// guaranteed by fast-forwarding past the base HLC (the doc's current master),
// not by the device tiebreak — so a server write always wins regardless of the
// client device id it races.
package hlc

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
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
	maxCounter     = 1e5 - 1 // 99999 — 5 digits; overflow advances physical
)

// Clock mints monotonically increasing HLC strings for the server node. Safe
// for concurrent use — one process-wide instance serializes all server writes
// through its mutex, which is cheap relative to the surrounding DB transaction.
type Clock struct {
	mu       sync.Mutex
	nodeID   string
	now      func() int64 // unix millis; injectable for tests
	lastPhys int64
	lastCtr  int64
}

// NewClock returns a Clock for the fixed server node using the wall clock.
func NewClock() *Clock {
	return &Clock{nodeID: ServerNodeID, now: func() int64 { return time.Now().UnixMilli() }}
}

// newClockAt is the test seam: a Clock driven by an injected millis source.
func newClockAt(now func() int64) *Clock {
	return &Clock{nodeID: ServerNodeID, now: now}
}

// Next mints an HLC strictly greater than both this clock's last-issued stamp
// AND the optional base (the document's current master HLC — pass "" for a
// brand-new doc). The standard HLC "send" rule: physical = max(wall, last,
// base); the counter bumps past whichever of last/base shares that physical so
// successive writes in the same millisecond stay strictly ordered.
func (c *Clock) Next(base string) string {
	c.mu.Lock()
	defer c.mu.Unlock()

	basePhys, baseCtr, hasBase := int64(0), int64(0), false
	if base != "" {
		if p, ct, ok := parse(base); ok {
			basePhys, baseCtr, hasBase = p, ct, true
		}
	}

	phys := c.now()
	if c.lastPhys > phys {
		phys = c.lastPhys
	}
	if hasBase && basePhys > phys {
		phys = basePhys
	}

	ctr := int64(0)
	if phys == c.lastPhys {
		if v := c.lastCtr + 1; v > ctr {
			ctr = v
		}
	}
	if hasBase && phys == basePhys {
		if v := baseCtr + 1; v > ctr {
			ctr = v
		}
	}
	if ctr > maxCounter {
		// Counter overflow within one millisecond (not reachable in practice) —
		// advance physical so the serialized width holds.
		phys++
		ctr = 0
	}

	c.lastPhys, c.lastCtr = phys, ctr
	return format(phys, ctr, c.nodeID)
}

// format serializes to the zero-padded wire string. Kept byte-for-byte
// compatible with the TS hlcToString so string comparison is order-preserving.
func format(phys, ctr int64, nodeID string) string {
	return fmt.Sprintf("%0*d:%0*d:%s", physicalDigits, phys, counterDigits, ctr, nodeID)
}

// parse extracts (physical, counter) from a wire HLC. The device id may itself
// contain ':', so only the first two separators matter. Returns ok=false on a
// structurally invalid string — the caller then treats it as "no base".
func parse(s string) (phys, ctr int64, ok bool) {
	first := strings.IndexByte(s, ':')
	if first < 0 {
		return 0, 0, false
	}
	second := strings.IndexByte(s[first+1:], ':')
	if second < 0 {
		return 0, 0, false
	}
	second += first + 1
	p, err := strconv.ParseInt(s[:first], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	ct, err := strconv.ParseInt(s[first+1:second], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return p, ct, true
}
