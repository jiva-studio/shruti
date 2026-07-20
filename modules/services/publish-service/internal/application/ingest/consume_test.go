package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/jiva-studio/shruti/publish/internal/store"
)

type fakeRepo struct {
	calls int
	last  store.Track
	err   error
}

func (f *fakeRepo) Upsert(_ context.Context, t store.Track) error {
	f.calls++
	f.last = t
	return f.err
}

// A track.ready event upserts the track with the typed columns pulled from the
// event Data and the whole Data retained as metadata.
func TestProcessReadyUpserts(t *testing.T) {
	fr := &fakeRepo{}
	h := New(fr)
	data := `{"status":"ready","track_id":"trk-9","lang":"en","title":"A Talk","audio_key":"public/tracks/trk-9/audio","transcript_key":"public/tracks/trk-9/transcript"}`
	ev := map[string]any{
		"id": "1-0", "type": "track.ready", "user_id": "user-1",
		"doc_id": "trk-9", "track_id": "trk-9", "data": json.RawMessage(data),
	}
	payload, _ := json.Marshal(ev)
	if err := h.Process(context.Background(), "1-0", payload); err != nil {
		t.Fatalf("process: %v", err)
	}
	if fr.calls != 1 {
		t.Fatalf("want 1 upsert, got %d", fr.calls)
	}
	got := fr.last
	if got.TrackID != "trk-9" || got.OwnerID != "user-1" {
		t.Errorf("track/owner = %q/%q", got.TrackID, got.OwnerID)
	}
	if got.Lang != "en" || got.AudioKey == "" || got.TranscriptKey == "" {
		t.Errorf("typed columns wrong: %+v", got)
	}
	if len(got.Metadata) == 0 {
		t.Errorf("metadata should retain the raw event data")
	}
}

// track_id falls back to doc_id when the top-level track_id is absent.
func TestProcessReadyTrackIDFallsBackToDocID(t *testing.T) {
	fr := &fakeRepo{}
	h := New(fr)
	payload, _ := json.Marshal(map[string]any{
		"type": "track.ready", "user_id": "u", "doc_id": "hash-1",
		"data": json.RawMessage(`{"lang":"ru"}`),
	})
	if err := h.Process(context.Background(), "2-0", payload); err != nil {
		t.Fatalf("process: %v", err)
	}
	if fr.last.TrackID != "hash-1" {
		t.Errorf("track_id = %q, want hash-1 (doc_id fallback)", fr.last.TrackID)
	}
}

// Non-ready lifecycle types are ACKed and ignored (no upsert).
func TestProcessIgnoresNonReady(t *testing.T) {
	fr := &fakeRepo{}
	h := New(fr)
	for _, typ := range []string{"track.queued", "track.processing", "track.failed"} {
		payload, _ := json.Marshal(map[string]any{"type": typ, "doc_id": "x"})
		if err := h.Process(context.Background(), "id", payload); err != nil {
			t.Fatalf("process %s: %v", typ, err)
		}
	}
	if fr.calls != 0 {
		t.Fatalf("non-ready must not upsert, got %d calls", fr.calls)
	}
}

// A malformed payload is dropped (ACKed) rather than wedging the group.
func TestProcessMalformedIsAcked(t *testing.T) {
	fr := &fakeRepo{}
	h := New(fr)
	if err := h.Process(context.Background(), "id", []byte("not json")); err != nil {
		t.Fatalf("malformed must ack (nil err), got %v", err)
	}
	if fr.calls != 0 {
		t.Fatalf("malformed must not upsert")
	}
}

// A DB failure is returned so the entry stays pending for redelivery.
func TestProcessDBErrorRedelivers(t *testing.T) {
	fr := &fakeRepo{err: errors.New("db down")}
	h := New(fr)
	payload, _ := json.Marshal(map[string]any{
		"type": "track.ready", "doc_id": "trk", "data": json.RawMessage(`{}`),
	})
	if err := h.Process(context.Background(), "id", payload); err == nil {
		t.Fatalf("db error must propagate to force redelivery")
	}
}
