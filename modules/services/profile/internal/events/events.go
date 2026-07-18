// Package events is the Personal Library ingest bridge: it will consume the
// Redis-Streams `track.events` stream (consumer group "profile") and project
// each event into a user's library_items row via the server-authored write
// path, and it will produce `library.unlinked` on a server-authored removal.
//
// STATUS: wired-but-INERT skeleton. The transport (go-redis XREADGROUP/XACK
// against STREAMS_REDIS_URL, the "profile" consumer group, and the
// library.unlinked outbox producer) DEPENDS on the streams broker landing in
// #1224. Everything below the transport — the Applier seam and the per-event
// projection — is real and unit-tested, so connecting the broker is the only
// remaining step. No go-redis dependency is added yet, to keep the binary free
// of dead code until it is actually used.
package events

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/profile/internal/wire"
)

// libraryItemsCollection is the single server-owned collection this bridge
// writes. Kept local so events has no dependency on store internals.
const libraryItemsCollection = "library_items"

// Applier is the subset of *service.Service the consumer needs — the
// server-authored write path. An interface (not the concrete type) so events
// has no import cycle with service and is trivially faked in tests.
type Applier interface {
	ApplyServerChange(ctx context.Context, userID uuid.UUID, collection, docID, op, eventID string, data json.RawMessage) (wire.Change, error)
}

// TrackEvent is one decoded `track.events` message. `type` selects the op:
// a `track.ready`/fetch-progress event upserts the projection; a removal event
// deletes it (and, once #1224 lands, emits `library.unlinked`). Data is the
// server-owned library_items payload projected verbatim by ApplyServerChange.
//
// ID is the broker message id — a monotonic idempotency key. It is passed to
// ApplyServerChange, which derives a DETERMINISTIC hlc from it, so a redelivered
// message writes exactly one change-log row instead of a duplicate.
type TrackEvent struct {
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	UserID uuid.UUID       `json:"user_id"`
	DocID  string          `json:"doc_id"`
	Data   json.RawMessage `json:"data"`
}

// Consumer reads track.events and applies each as a server-authored change.
type Consumer struct {
	Applier Applier
	// TODO(#1224): StreamsURL string, a go-redis client, and the "profile"
	// consumer group id — supplied once the streams broker exists.
}

// Run will start the XREADGROUP loop. INERT until the broker lands (#1224): it
// blocks until the context is cancelled so a caller can wire it into the
// service lifecycle today without it doing (or breaking) anything.
func (c *Consumer) Run(ctx context.Context) error {
	// TODO(#1224): connect to STREAMS_REDIS_URL; XREADGROUP GROUP profile ...;
	// for each message set TrackEvent.ID to the stream message id, call handle,
	// XACK on success. Redelivery is safe: ApplyServerChange derives a
	// deterministic hlc from that id, so the change log stays idempotent on
	// (user_id, collection, doc_id, hlc).
	<-ctx.Done()
	return ctx.Err()
}

// handle projects a single decoded event through the server-authored write
// path. This is the real logic the deferred transport will call per message;
// it is exercised directly by the package tests.
func (c *Consumer) handle(ctx context.Context, ev TrackEvent) error {
	op := "upsert"
	if ev.Type == "track.removed" {
		// TODO(#1224): also emit a `library.unlinked` event to the outbox.
		op = "delete"
	}
	_, err := c.Applier.ApplyServerChange(ctx, ev.UserID, libraryItemsCollection, ev.DocID, op, ev.ID, ev.Data)
	return err
}
