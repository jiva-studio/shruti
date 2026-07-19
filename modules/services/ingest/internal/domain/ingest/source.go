// Package ingest holds the personal-library ingest domain — the kind-specific
// core behind a `library_ingest` job. It stays dependency-light (stdlib only)
// so the generic job aggregate and the ports layer can reference it freely.
//
// The pipeline drives a WorkCommand's URL through fetch -> transcribe -> review,
// mutating a TrackDraft, and content-addresses the audio into a stable track_id
// via ContentID.
package ingest
