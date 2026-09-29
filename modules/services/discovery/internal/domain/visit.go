package domain

import "time"

// Page is one URL we have fetched, with the validators that make the next
// visit cheap and the schedule that decides when it happens.
type Page struct {
	ID                   int64
	SourceID             *string
	URL                  string
	ETag                 string
	LastModified         string
	BodySHA256           string
	ItemSetSHA256        string
	HTTPStatus           int
	Error                string
	LastFetchedAt        *time.Time
	ConsecutiveUnchanged int
	// ConsecutiveFailures backs off a page that keeps failing, the same way
	// ConsecutiveUnchanged backs off one that keeps not changing.
	ConsecutiveFailures int
	NextCheckAt         *time.Time
	// MediaFound is how many media addresses this page offered. Zero is a fact
	// worth keeping: it is how you find the pages we visited and came away from
	// empty-handed.
	MediaFound int
	// NormPromptVersion is the prompt this page's files were last read with.
	// A newer prompt means the stored answers are stale even when the page is
	// byte-identical.
	NormPromptVersion string
	// ScriptVersion is the archive's own extraction script, for the same
	// reason: correcting a script must re-read what the old one wrote, and
	// without this editing one appears to do nothing.
	ScriptVersion string
}

// Work is one address the scheduler should read, and which archive asked for
// it.
type Work struct {
	URL      string
	SourceID string
}

// ShapeYield is what pages of one URL shape have turned out to be worth.
type ShapeYield struct {
	Pages int
	Media int
}
