// Package tagger writes ID3 metadata into an mp3 file. Used by the
// audiotag use case after a track is committed so the file in
// public/tracks/{id}/audio/original.mp3 carries playable metadata for
// any desktop player that picks it up.
package tagger

import "context"

// Tags is the de-vendored shape consumed by adapters; concrete frame names
// (TIT2/TPE1/TXXX/...) are the adapter's concern.
type Tags struct {
	Title         string // TIT2
	Artist        string // TPE1
	AlbumArtist   string // TPE2
	Album         string // TALB
	RecordingDate string // TDRC, ISO YYYY-MM-DD
	Year          string // TYER, YYYY
	Genre         string // TCON
	Language      string // TLAN, ISO-639
	Comment       string // COMM
	TrackID       string // TXXX:track_id custom user-defined frame for catalog lookup
}

type Tagger interface {
	// Tag replaces the file's ID3 tag in place: any prior frames are
	// dropped first (so embedded covers / stale text / lyrics from the
	// source file don't survive), then the requested frames are written
	// fresh. Idempotent — re-running yields the same on-disk bytes.
	Tag(ctx context.Context, mp3Path string, tags Tags) error
}
