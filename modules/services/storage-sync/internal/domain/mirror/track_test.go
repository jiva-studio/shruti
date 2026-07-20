package mirror

import "testing"

// The EXACT envelope the orchestrator's relay emits on track.events — the blob
// keys live inside the server-owned `data` projection, not at the top level.
// This is the Go↔Go seam that has broken before, so it is asserted verbatim.
func TestDecodeTrackReadyRealEnvelope(t *testing.T) {
	payload := []byte(`{
	  "id": "job-1:ready",
	  "type": "track.ready",
	  "user_id": "3f6a1f0e-0000-4000-8000-000000000001",
	  "doc_id": "job-1",
	  "track_id": "hash123",
	  "data": {
	    "status": "ready",
	    "track_id": "hash123",
	    "lang": "en",
	    "title_raw": "A talk",
	    "audio_key": "public/tracks/hash123/audio/original.mp3",
	    "transcript_key": "public/tracks/hash123/transcripts/en.json",
	    "source_url": "https://x/y"
	  }
	}`)

	got, ok, err := DecodeTrackReady(payload)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !ok {
		t.Fatal("a track.ready with blob keys must be actionable")
	}
	if got.TrackID != "hash123" {
		t.Errorf("track_id = %q, want hash123", got.TrackID)
	}
	want := []string{
		"public/tracks/hash123/audio/original.mp3",
		"public/tracks/hash123/transcripts/en.json",
	}
	keys := got.Keys()
	if len(keys) != 2 || keys[0] != want[0] || keys[1] != want[1] {
		t.Fatalf("keys = %v, want %v (audio first)", keys, want)
	}
}

// Every other lifecycle type is "nothing to mirror" — not an error, so the
// consumer acks and moves on.
func TestDecodeTrackReadyIgnoresOtherTypes(t *testing.T) {
	for _, typ := range []string{"track.queued", "track.processing", "track.failed", "track.removed"} {
		payload := []byte(`{"type":"` + typ + `","data":{"audio_key":"a","transcript_key":"b"}}`)
		_, ok, err := DecodeTrackReady(payload)
		if err != nil {
			t.Fatalf("%s: unexpected error %v", typ, err)
		}
		if ok {
			t.Errorf("%s must not be actionable", typ)
		}
	}
}

// A ready event carrying no blob keys has nothing to mirror.
func TestDecodeTrackReadyNoKeys(t *testing.T) {
	_, ok, err := DecodeTrackReady([]byte(`{"type":"track.ready","track_id":"h","data":{}}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("no blob keys must not be actionable")
	}
}

// A malformed payload surfaces as an error so the caller can drop it as a
// poison pill rather than retrying forever.
func TestDecodeTrackReadyMalformed(t *testing.T) {
	if _, _, err := DecodeTrackReady([]byte(`{not json`)); err == nil {
		t.Fatal("expected a decode error for malformed json")
	}
}

// Keys skips an empty half rather than emitting a blank key.
func TestKeysSkipsEmpty(t *testing.T) {
	if got := (TrackReady{AudioKey: "a"}).Keys(); len(got) != 1 || got[0] != "a" {
		t.Fatalf("keys = %v, want [a]", got)
	}
	if got := (TrackReady{}).Keys(); len(got) != 0 {
		t.Fatalf("keys = %v, want empty", got)
	}
}
