package events

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/profile/internal/wire"
)

// fakeApplier records the last server-authored change the consumer requested.
type fakeApplier struct {
	collection, docID, op, eventID string
	data                           json.RawMessage
	calls                          int
}

func (f *fakeApplier) ApplyServerChange(_ context.Context, _ uuid.UUID, collection, docID, op, eventID string, data json.RawMessage) (wire.Change, error) {
	f.calls++
	f.collection, f.docID, f.op, f.eventID, f.data = collection, docID, op, eventID, data
	return wire.Change{Collection: collection, DocID: docID, Op: op, Data: data}, nil
}

// A track.ready event projects an upsert into library_items via the applier.
func TestHandleUpsertsLibraryItem(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{
		ID:     "1718000000000-0",
		Type:   "track.ready",
		UserID: uuid.New(),
		DocID:  "lib-1",
		Data:   json.RawMessage(`{"status":"ready","track_id":"trk-9"}`),
	}
	if err := c.handle(context.Background(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.calls != 1 {
		t.Fatalf("expected exactly one ApplyServerChange call, got %d", fa.calls)
	}
	if fa.collection != libraryItemsCollection {
		t.Errorf("collection: want %q, got %q", libraryItemsCollection, fa.collection)
	}
	if fa.docID != "lib-1" || fa.op != "upsert" {
		t.Errorf("want doc lib-1 op upsert, got doc %q op %q", fa.docID, fa.op)
	}
	// The broker message id is threaded through as the idempotency key.
	if fa.eventID != ev.ID {
		t.Errorf("event id: want %q, got %q", ev.ID, fa.eventID)
	}
}

// A removal event maps to a delete op.
func TestHandleRemovedIsDelete(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{ID: "1718000000001-0", Type: "track.removed", UserID: uuid.New(), DocID: "lib-2"}
	if err := c.handle(context.Background(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.op != "delete" {
		t.Errorf("removal must map to delete, got %q", fa.op)
	}
}

// A non-lifecycle event type (queued/processing/failed) is ignored — no write.
func TestHandleIgnoresOtherTypes(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	for _, typ := range []string{"track.queued", "track.processing", "track.failed"} {
		ev := TrackEvent{ID: "x", Type: typ, UserID: uuid.New(), DocID: "d"}
		if err := c.handle(context.Background(), ev); err != nil {
			t.Fatalf("handle %s: %v", typ, err)
		}
	}
	if fa.calls != 0 {
		t.Fatalf("non-lifecycle types must not write, got %d calls", fa.calls)
	}
}

// fakePublishApplier records the last MarkPublished request.
type fakePublishApplier struct {
	userID  uuid.UUID
	trackID string
	eventID string
	calls   int
}

func (f *fakePublishApplier) MarkPublished(_ context.Context, userID uuid.UUID, trackID, eventID string) error {
	f.calls++
	f.userID, f.trackID, f.eventID = userID, trackID, eventID
	return nil
}

// A track.published event flips the item's origin for its track_id.
func TestPublishedConsumerMarksPublished(t *testing.T) {
	fp := &fakePublishApplier{}
	c := &PublishedConsumer{Applier: fp}
	owner := uuid.New()
	ev := PublishedEvent{Type: "track.published", TrackID: "trk-9", OwnerID: owner}
	if err := c.handle(context.Background(), "1700000000000-0", ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fp.calls != 1 || fp.trackID != "trk-9" || fp.userID != owner || fp.eventID != "1700000000000-0" {
		t.Errorf("MarkPublished not called correctly: calls=%d track=%q user=%v event=%q", fp.calls, fp.trackID, fp.userID, fp.eventID)
	}
}

// A published event with no track_id is dropped (acked) without a write.
func TestPublishedConsumerDropsEmptyTrackID(t *testing.T) {
	fp := &fakePublishApplier{}
	c := &PublishedConsumer{Applier: fp}
	if err := c.handle(context.Background(), "1700000000000-0", PublishedEvent{Type: "track.published"}); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fp.calls != 0 {
		t.Fatalf("empty track_id must not write")
	}
}
