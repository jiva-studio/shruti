package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

// fakeApplier records the last lifecycle change the consumer requested.
type fakeApplier struct {
	docID, op  string
	generation int
	rank       int
	data       json.RawMessage
	calls      int
}

func (f *fakeApplier) ApplyLibraryLifecycle(_ context.Context, _ uuid.UUID, docID, op string, generation, rank int, data json.RawMessage) (changes.Change, error) {
	f.calls++
	f.docID, f.op, f.generation, f.rank, f.data = docID, op, generation, rank, data
	return changes.Change{Collection: changes.LibraryItems, DocID: docID, Op: op, Data: data}, nil
}

// A track.ready event projects an upsert into library_items at the ready rank.
func TestHandleUpsertsLibraryItem(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{
		Type:   "track.ready",
		UserID: uuid.New(),
		DocID:  "lib-1",
		Data:   json.RawMessage(`{"status":"ready","track_id":"trk-9"}`),
	}
	if err := c.handle(t.Context(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.calls != 1 {
		t.Fatalf("expected exactly one ApplyLibraryLifecycle call, got %d", fa.calls)
	}
	if fa.docID != "lib-1" || fa.op != "upsert" || fa.rank != 3 {
		t.Errorf("want doc lib-1 upsert rank 3, got doc %q op %q rank %d", fa.docID, fa.op, fa.rank)
	}
}

// A removal event maps to a delete op above the lifecycle ranks.
func TestHandleRemovedIsDelete(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{Type: "track.removed", UserID: uuid.New(), DocID: "lib-2"}
	if err := c.handle(t.Context(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.op != "delete" || fa.rank != 4 {
		t.Errorf("removal must be delete rank 4, got op %q rank %d", fa.op, fa.rank)
	}
}

// Every lifecycle state projects an upsert, and the ranks are strictly ordered
// queued < processing < ready = failed so a later state wins last-writer-wins.
// An unknown type is ignored (no write).
func TestHandleProjectsLifecycleWithMonotonicRank(t *testing.T) {
	cases := []struct {
		typ  string
		rank int
	}{
		{"track.queued", 1},
		{"track.processing", 2},
		{"track.failed", 3},
		{"track.ready", 3},
	}
	var queued, processing, ready int
	for _, tc := range cases {
		fa := &fakeApplier{}
		c := &Consumer{Applier: fa}
		ev := TrackEvent{Type: tc.typ, UserID: uuid.New(), DocID: "d",
			Data: json.RawMessage(`{"status":"x","title_raw":"t"}`)}
		if err := c.handle(t.Context(), ev); err != nil {
			t.Fatalf("handle %s: %v", tc.typ, err)
		}
		if fa.calls != 1 || fa.op != "upsert" || fa.rank != tc.rank {
			t.Errorf("%s: want upsert rank %d, got calls %d op %q rank %d", tc.typ, tc.rank, fa.calls, fa.op, fa.rank)
		}
		switch tc.typ {
		case "track.queued":
			queued = fa.rank
		case "track.processing":
			processing = fa.rank
		case "track.ready":
			ready = fa.rank
		}
	}
	if !(queued < processing && processing < ready) {
		t.Fatalf("ranks not monotonic: queued=%d processing=%d ready=%d", queued, processing, ready)
	}

	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	if err := c.handle(t.Context(), TrackEvent{Type: "unknown.type", UserID: uuid.New(), DocID: "d"}); err != nil {
		t.Fatalf("handle unknown: %v", err)
	}
	if fa.calls != 0 {
		t.Fatalf("unknown type must not write, got %d calls", fa.calls)
	}
}

// A re-run event carries its generation through to the applier so the stamp can
// lift the retry above the prior run's terminal state. A generation-0 (original)
// event, and one where the field is absent from the wire, both project at 0.
func TestHandlePropagatesGeneration(t *testing.T) {
	fa := &fakeApplier{}
	c := &Consumer{Applier: fa}
	ev := TrackEvent{Type: "track.ready", UserID: uuid.New(), DocID: "d", Generation: 2,
		Data: json.RawMessage(`{"status":"ready"}`)}
	if err := c.handle(t.Context(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fa.generation != 2 {
		t.Errorf("want generation 2 propagated, got %d", fa.generation)
	}

	var decoded TrackEvent
	if err := json.Unmarshal([]byte(`{"type":"track.queued","doc_id":"d"}`), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.Generation != 0 {
		t.Errorf("absent generation must decode to 0, got %d", decoded.Generation)
	}
}

// fakePublishApplier records the last MarkPublished request.
type fakePublishApplier struct {
	userID  uuid.UUID
	trackID string
	calls   int
	err     error
}

func (f *fakePublishApplier) MarkPublished(_ context.Context, userID uuid.UUID, trackID string) error {
	f.calls++
	f.userID, f.trackID = userID, trackID
	return f.err
}

// A track.published event flips the item's origin for its track_id.
func TestPublishedConsumerMarksPublished(t *testing.T) {
	fp := &fakePublishApplier{}
	c := &PublishedConsumer{Applier: fp}
	owner := uuid.New()
	ev := PublishedEvent{Type: "track.published", TrackID: "trk-9", OwnerID: owner}
	if err := c.handle(t.Context(), ev); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fp.calls != 1 || fp.trackID != "trk-9" || fp.userID != owner {
		t.Errorf("MarkPublished not called correctly: calls=%d track=%q user=%v", fp.calls, fp.trackID, fp.userID)
	}
}

// A published event with no track_id is dropped (acked) without a write.
func TestPublishedConsumerDropsEmptyTrackID(t *testing.T) {
	fp := &fakePublishApplier{}
	c := &PublishedConsumer{Applier: fp}
	if err := c.handle(t.Context(), PublishedEvent{Type: "track.published"}); err != nil {
		t.Fatalf("handle: %v", err)
	}
	if fp.calls != 0 {
		t.Fatalf("empty track_id must not write")
	}
}

func publishedPayload(t *testing.T) []byte {
	t.Helper()
	b, err := json.Marshal(PublishedEvent{Type: "track.published", TrackID: "trk-9", OwnerID: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// streamID is a Redis auto id added at the given time.
func streamID(at time.Time) string {
	return fmt.Sprintf("%d-0", at.UnixMilli())
}

// A promotion that arrives before its library item projected stays pending
// while it is young, so the reclaim pass redelivers it.
func TestPublishedConsumerRetriesAnUnprojectedFlipWithinTheWindow(t *testing.T) {
	fp := &fakePublishApplier{err: changes.ErrNotProjected}
	c := NewPublishedConsumer(fp, nil, "track.published", "profile-published", "c1")
	err := c.process(t.Context(), streamID(time.Now().Add(-time.Minute)), publishedPayload(t))
	if !errors.Is(err, changes.ErrNotProjected) {
		t.Fatalf("err = %v, want ErrNotProjected so the entry stays pending", err)
	}
}

// A promotion whose item never projected is acknowledged once it is older than
// the retry window, so it cannot be redelivered forever.
func TestPublishedConsumerDropsAnUnprojectedFlipPastTheWindow(t *testing.T) {
	fp := &fakePublishApplier{err: changes.ErrNotProjected}
	c := NewPublishedConsumer(fp, nil, "track.published", "profile-published", "c1")
	if err := c.process(t.Context(), streamID(time.Now().Add(-30*24*time.Hour)), publishedPayload(t)); err != nil {
		t.Fatalf("err = %v, want nil so the entry is acknowledged", err)
	}
	if fp.calls != 1 {
		t.Fatalf("MarkPublished calls = %d, want 1", fp.calls)
	}
}

// Any other failure is retried however old the entry is.
func TestPublishedConsumerRetriesOtherErrorsPastTheWindow(t *testing.T) {
	down := errors.New("database unreachable")
	fp := &fakePublishApplier{err: down}
	c := NewPublishedConsumer(fp, nil, "track.published", "profile-published", "c1")
	if err := c.process(t.Context(), streamID(time.Now().Add(-30*24*time.Hour)), publishedPayload(t)); !errors.Is(err, down) {
		t.Fatalf("err = %v, want the write failure returned", err)
	}
}
