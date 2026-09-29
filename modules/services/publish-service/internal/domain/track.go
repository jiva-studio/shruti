// Package domain holds what the promotion side knows about a track.
package domain

// Track is one track learned from a `track.ready` event. Metadata is the raw
// event data kept verbatim, so the pending.db review artifact can be rebuilt
// from it.
type Track struct {
	TrackID       string
	OwnerID       string
	Metadata      []byte
	Lang          string
	AudioKey      string
	TranscriptKey string
}

// Promotion is one track flipped from unpublished to published, with the
// owner its announcement names.
type Promotion struct {
	TrackID string
	OwnerID string
}
