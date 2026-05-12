package track

import "time"

// SourceFile describes an mp3 file as found in the input lake.
// Path is the registry's primary key — absolute, symlinks resolved.
// Language is the ISO-639 code derived from the dedup-tool's canonical
// layout (outbox/sorted/<lang>/...); empty when the file isn't under
// that tree (test fixtures, ad-hoc ingests). Stored on the file row
// so transcribe/review can pick the right variant without re-parsing
// or waiting on the metadata stage.
type SourceFile struct {
	Path         string
	SHA256       string
	Size         int64
	Language     string
	DiscoveredAt time.Time
}
