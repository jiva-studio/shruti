package ingest

// TrackDraft is the mutable working set for a single track during ingest: the
// raw metadata as scraped from the source or heard in the audio, alongside the
// resolved (dictionary-linked) values the review stage fills in. It is the
// payload behind a library_ingest job's Spec until the track is committed.
type TrackDraft struct {
	// Raw — as extracted from the source (title tag, description, ASR output),
	// before any dictionary resolution. Free-form, possibly noisy.
	TitleRaw    string
	AuthorRaw   string
	LocationRaw string
	DateRaw     string
	LangHint    string

	// Resolved — dictionary ids / normalized values produced by the Reviewer.
	// Zero until resolved.
	AuthorID   string
	LocationID string
	Date       string // canonical ISO-8601; may be a partial date (e.g. "1972")
	Lang       string // ISO-639 code
}
