package redisstream

import (
	"context"
	"errors"
	"testing"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
)

type fakeSyncer struct {
	got    mirror.TrackReady
	calls  int
	err    error
	copied int
}

func (f *fakeSyncer) SyncTrack(_ context.Context, t mirror.TrackReady) (int, error) {
	f.calls++
	f.got = t
	return f.copied, f.err
}

const readyPayload = `{
  "id":"job-1:ready","type":"track.ready","doc_id":"job-1","track_id":"h1",
  "data":{"status":"ready","track_id":"h1","lang":"en",
          "audio_key":"public/tracks/h1/audio/original.mp3",
          "transcript_key":"public/tracks/h1/transcripts/en.json"}
}`

// A track.ready drives the mirror with the blob keys from the event.
func TestHandleMirrorsReadyTrack(t *testing.T) {
	f := &fakeSyncer{copied: 2}
	c := &Consumer{syncer: f}

	if err := c.Handle(context.Background(), []byte(readyPayload)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if f.calls != 1 {
		t.Fatalf("SyncTrack calls = %d, want 1", f.calls)
	}
	if got := f.got.Keys(); len(got) != 2 {
		t.Fatalf("keys = %v, want both blobs", got)
	}
	if f.got.TrackID != "h1" {
		t.Errorf("track_id = %q, want h1", f.got.TrackID)
	}
}

// Other lifecycle types are acked without any mirroring work.
func TestHandleIgnoresNonReadyTypes(t *testing.T) {
	for _, typ := range []string{"track.queued", "track.processing", "track.failed"} {
		f := &fakeSyncer{}
		c := &Consumer{syncer: f}
		payload := []byte(`{"type":"` + typ + `","data":{"audio_key":"a"}}`)
		if err := c.Handle(context.Background(), payload); err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		if f.calls != 0 {
			t.Errorf("%s must not trigger a sync", typ)
		}
	}
}

// A malformed payload is dropped (acked), not retried forever — it can never
// become valid, so leaving it pending would wedge the group.
func TestHandleDropsPoisonPill(t *testing.T) {
	f := &fakeSyncer{}
	c := &Consumer{syncer: f}
	if err := c.Handle(context.Background(), []byte(`{not json`)); err != nil {
		t.Fatalf("a poison pill must be acked, got error %v", err)
	}
	if f.calls != 0 {
		t.Fatal("poison pill must not trigger a sync")
	}
}

// A mirroring failure surfaces so the entry stays pending and the reclaim
// retries it.
func TestHandlePropagatesSyncError(t *testing.T) {
	f := &fakeSyncer{err: errors.New("yandex down")}
	c := &Consumer{syncer: f}
	if err := c.Handle(context.Background(), []byte(readyPayload)); err == nil {
		t.Fatal("expected the sync error to propagate so the message is retried")
	}
}

// An empty payload (a message without the `payload` field) is acked, not retried.
func TestHandleEmptyPayload(t *testing.T) {
	f := &fakeSyncer{}
	c := &Consumer{syncer: f}
	if err := c.Handle(context.Background(), nil); err != nil {
		t.Fatalf("empty payload must be acked, got %v", err)
	}
	if f.calls != 0 {
		t.Fatal("empty payload must not trigger a sync")
	}
}
