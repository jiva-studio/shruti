package events

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// fakeApplier records the last server-authored change the consumer requested.
type fakeApplier struct {
	collection, docID, op string
	data                  json.RawMessage
	calls                 int
}

func (f *fakeApplier) ApplyServerChange(_ context.Context, _ uuid.UUID, collection, docID, op string, data json.RawMessage) (wire.Change, error) {
	f.calls++
	f.collection, f.docID, f.op, f.data = collection, docID, op, data
	return wire.Change{Collection: collection, DocID: docID, Op: op, Data: data}, nil
}

// A track.ready event projects an upsert into library_items via the applier.
func TestHandleUpsertsLibraryItem(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{
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
}

// A removal event maps to a delete op.
func TestHandleRemovedIsDelete(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{Type: "track.removed", UserID: uuid.New(), DocID: "lib-2"}
	if err := c.handle(context.Background(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.op != "delete" {
		t.Errorf("removal must map to delete, got %q", fa.op)
	}
}
