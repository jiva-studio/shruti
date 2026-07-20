package mirror

import "encoding/json"

// TrackReady is the orchestrator's `track.ready` lifecycle event reduced to what
// the mirror cares about: which blobs a freshly ingested track just published.
//
// Why the mirror listens at all: ingest writes to Bunny (the source of truth),
// but a reader served by the Russia mirror only sees an object after the next
// full pass — up to SYNC_INTERVAL (an hour in production) later. A user who has
// just added a lecture would get a track the app reports as "ready" whose audio
// 404s for them. Reacting to the event ships those two objects in seconds; the
// periodic full pass stays as the reconciler and the safety net.
type TrackReady struct {
	TrackID string
	// RequestID is the originating chat turn's trace_id, carried through the
	// whole pipeline so a mirror copy is greppable on the same id as the ingest
	// that produced it. Empty for events from before the id was propagated, and
	// for the periodic full pass (which has no originating request).
	RequestID     string
	AudioKey      string
	TranscriptKey string
}

// Keys returns the blob keys this event implies, skipping empties. Order is
// stable (audio first) so a partial failure is deterministic and re-runnable.
func (t TrackReady) Keys() []string {
	keys := make([]string, 0, 2)
	if t.AudioKey != "" {
		keys = append(keys, t.AudioKey)
	}
	if t.TranscriptKey != "" {
		keys = append(keys, t.TranscriptKey)
	}
	return keys
}

// trackEvent mirrors the wire shape the orchestrator's relay emits on
// `track.events`: `{id, type, request_id, user_id, doc_id, track_id, data}`
// where the blob
// keys live inside the server-owned `data` projection.
type trackEvent struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	TrackID   string `json:"track_id"`
	Data      struct {
		TrackID       string `json:"track_id"`
		AudioKey      string `json:"audio_key"`
		TranscriptKey string `json:"transcript_key"`
	} `json:"data"`
}

// TypeTrackReady is the only event type the mirror acts on.
const TypeTrackReady = "track.ready"

// DecodeTrackReady parses one `track.events` payload. It returns ok=false for
// any event that is not a `track.ready` or that carries no blob keys — both are
// "nothing to mirror", not errors, so the caller acks and moves on. A malformed
// payload returns an error so the caller can decide (drop as a poison pill).
func DecodeTrackReady(payload []byte) (TrackReady, bool, error) {
	var ev trackEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		return TrackReady{}, false, err
	}
	if ev.Type != TypeTrackReady {
		return TrackReady{}, false, nil
	}
	trackID := ev.TrackID
	if trackID == "" {
		trackID = ev.Data.TrackID
	}
	t := TrackReady{
		TrackID:       trackID,
		RequestID:     ev.RequestID,
		AudioKey:      ev.Data.AudioKey,
		TranscriptKey: ev.Data.TranscriptKey,
	}
	if len(t.Keys()) == 0 {
		return TrackReady{}, false, nil
	}
	return t, true, nil
}
