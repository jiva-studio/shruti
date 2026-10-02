package domain

import (
	"encoding/json"
	"time"
)

// Recording statuses: found, and read.
const (
	StatusDiscovered = "discovered"
	StatusNormalized = "normalized"
)

// What the last visit saw of a recording's file.
const (
	// MediaPresent — the address was on the page.
	MediaPresent = "present"
	// MediaVanished — it was there before and was not this time. Which of "the
	// archive removed it" and "our session expired" that means is not knowable
	// at the moment it happens; MediaMissingSince tells you later.
	MediaVanished = "vanished"
)

// OriginCrawl names what wrote a reference: an ordinary visit to the page.
const OriginCrawl = "crawl"

// Recording is one media file as stored: what extraction found on a page,
// merged with what the normalizer or the archive's own script said about it.
// The media URL is the natural key.
type Recording struct {
	ID       int64
	MediaURL string
	SourceID *string
	PageID   *int64

	// Raw is everything extraction found, which is what the normalizer is shown.
	// Kept so a recording can be read again with a new prompt out of our own
	// rows rather than by fetching its page again.
	Raw json.RawMessage

	Title  string
	Author string
	// Authors is everyone who spoke; Author is the one written on the recording.
	Authors    []string
	Location   string
	RecordedOn *time.Time
	Language   string
	DurationS  int
	// CoverURL is the picture the archive publishes for this recording, as the
	// script that read the page said it.
	CoverURL        string
	Summary         string
	References      []Ref
	CollectionTitle string

	MediaState        string
	MediaSeenAt       *time.Time
	MediaMissingSince *time.Time

	NormInputSHA256   string
	NormPromptVersion string
	NormModel         string

	Status      string
	FirstSeenAt time.Time
	LastSeenAt  time.Time
}

// ItemText is prose an archive published about a recording, in one language.
type ItemText struct {
	Lang string
	Text string
}

// Collection is a cycle of recordings: a course, a seminar, a set of talks
// given together.
//
// Its identity is the URL of the page that presents it, when there is one.
// Where an archive names the cycle on each part and has no page for it, the
// title within the archive has to serve instead.
type Collection struct {
	ID          int64
	SourceID    string
	URL         string
	Title       string
	Description string
	Author      string
	// MemberCount is counted from the membership rows when asked. It is not
	// stored: a number kept alongside the rows it counts is a number that will
	// disagree with them.
	MemberCount int
}
