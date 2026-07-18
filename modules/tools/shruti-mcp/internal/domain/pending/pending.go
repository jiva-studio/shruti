// Package pending holds the domain types for the corpus-promotion queue —
// the "user-generated" rows the admin reviews and promotes into the
// shared catalog (Phase-2 admin promotion, epic #1236, issue #1233).
//
// The queue is delivered to the offline admin MCP as a published SQLite
// artifact (pending.db) on S3/CDN, self-fetched exactly like current.db (see
// internal/application/pending/refresh). The prod producer that WRITES
// pending.db (profile / orchestrator) is out of scope here; this package plus
// the sqlite adapter implement the READ side the admin tools consume.
package pending

// Track is one user-generated row: a user-added ("personal library")
// lecture, already published to the public CDN, that the admin may promote
// into the shared corpus. Users never submit anything — the admin browses
// these and approves.
//
// Metadata is RAW (as the user/ingest supplied it) — author/location/source
// names are unresolved strings. The admin normalizes them to canonical dict
// ids at the promotion gate (library.approve) via <dict>.resolve / *.create;
// nothing here is auto-created.
//
// The transcript / audio paths are the ALREADY-PUBLIC CDN keys of the personal
// track. Promotion is zero-copy: the corpus track reuses the same TrackID and
// the same bytes — no re-upload, no re-transcode.
type Track struct {
	TrackID   string `json:"track_id"`   // stable id, preserved into the corpus
	OwnerID   string `json:"owner_id"`   // user who contributed → contributor_user_id
	TitleRaw  string `json:"title_raw"`  // title (raw)
	AuthorRaw string `json:"author_raw"` // speaker name (raw, unresolved)
	LocationRaw string `json:"location_raw"` // place (raw, unresolved); may be empty
	DateRaw   string `json:"date_raw"`   // YYYY-MM-DD if known; may be empty
	ReferencesRaw string `json:"references_raw"` // opaque JSON of scripture refs; may be empty
	Lang      string `json:"lang"`       // transcript / variant language

	// Already-published CDN keys of the personal track (zero-copy promotion).
	TranscriptPath string `json:"transcript_path"` // e.g. public/tracks/<id>/transcripts/<lang>.json
	AudioPath      string `json:"audio_path"`      // e.g. public/tracks/<id>/audio/original.mp3
	AudioDurationMs int64 `json:"audio_duration_ms"`
	AudioSizeBytes  int64 `json:"audio_size_bytes"`

	CreatedAt string `json:"created_at"` // RFC3339, set by the producer
	// ConsumedAt is set by the admin MCP (library.approve) once the row has
	// been promoted, so a later producer pass can reconcile / drop it. Empty =
	// still pending.
	ConsumedAt string `json:"consumed_at,omitempty"`
}

// ListOpts narrows a pending listing.
type ListOpts struct {
	// IncludeConsumed returns rows already marked consumed as well. Default
	// (false) lists only rows still awaiting review.
	IncludeConsumed bool
	Limit           int    // page size; 0 = repo default
	Cursor          string // last-seen track_id, exclusive
}
