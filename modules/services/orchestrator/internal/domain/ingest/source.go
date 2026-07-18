// Package ingest holds the personal-library ingest domain — the kind-specific
// core behind a `library_ingest` job. It stays dependency-light (stdlib only)
// so the generic job aggregate and the ports layer can reference it freely.
//
// The pipeline (issues #1221–#1223) drives a Source through fetch -> transcribe
// -> review, mutating a TrackDraft, and content-addresses the audio into a
// stable track_id via ContentID.
package ingest

// Source is a concrete ingest input: a URL to fetch plus a coarse kind hint
// (e.g. "youtube", "podcast", "file") the fetcher uses to pick an adapter. Kind
// is advisory — the fetcher may refine or reject it.
type Source struct {
	URL  string
	Kind string
}
