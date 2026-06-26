package catalog

// Kind identifies a dictionary table in the catalog.
type Kind string

const (
	KindAuthor   Kind = "author"
	KindLocation Kind = "location"
	KindSource   Kind = "source"
	KindTag      Kind = "tag"
	KindTopic    Kind = "topic"
)

// IDPrefix returns the per-kind ID prefix per docs/repos/shruti/db/ids.md.
func (k Kind) IDPrefix() string {
	switch k {
	case KindAuthor:
		return "author_"
	case KindLocation:
		return "location_"
	case KindSource:
		return "source_"
	case KindTag:
		return "tag_"
	case KindTopic:
		return "topic_"
	}
	return ""
}

// DictEntry is one dictionary row collapsed across locales.
//
//	Names      : language → full_name (one row per locale in DB)
//	ShortName  : language → short_name (sources and topics)
type DictEntry struct {
	Id        string
	Names     map[string]string
	ShortName map[string]string // populated for KindSource and KindTopic
}

// TopicCover is one topic's cover-generation status: the id and whether a cover
// image is already stored. Used by the batch cover build to skip done topics.
type TopicCover struct {
	ID       string
	HasCover bool
}

// ListOpts is shared by *_list tools.
type ListOpts struct {
	Language *string
	Query    *string
	Limit    int
	Cursor   string
}

// TrackReference is one resolved scripture citation written to track_references.
type TrackReference struct {
	SourceID string
	Tokens   string
}

// TrackRow is what the commit stage writes to the catalog.
type TrackRow struct {
	Id         string
	AuthorID   string
	LocationID string
	Date       string // YYYY-MM-DD; empty = unknown
	Hidden     bool
	// TagIDs lists kind-tag ids (tag_morning_walk, tag_conversation, …) that
	// classify this track. Wire-mapped to the canonical track_tags join table.
	// Track-level (not per-variant): "morning walk" stays a morning walk
	// regardless of subtitle/dub language.
	TagIDs []string
}

// VariantRow is one (track, language) row in track_variants.
//
// SortReference is the by-reference sort key for THIS locale. It carries the
// localized source short_name as its leading prefix so a `ORDER BY
// sort_reference` honors the user's alphabet ("БГ_…" < "ШБ_…" for Russian,
// "BG_…" < "SB_…" for English). The numeric tail uses zero-padded chapter/
// verse tokens for stable lexical ordering inside a source. nil = no
// scriptural reference (Morning Walks, Conversations) — sorted last via
// SQL `NULLS LAST` regardless of locale.
type VariantRow struct {
	TrackID        string
	Language       string
	Title          string
	TranscriptPath string
	TranscriptKind string
	SortReference  *string

	// Outline is the lecture's section table-of-contents as a JSON array of
	// {title,start,end} (ms), generated from the reviewed transcript. "" = none.
	Outline string
	// Description is a short per-locale overview of the lecture. "" = none.
	Description string

	// TranscriptSHA256 is the hex sha256 of the published transcript file
	// (public/tracks/<id>/transcripts/<lang>.json). Recorded in asset_hashes
	// as the change-token the chat indexer diffs against (replaces the S3
	// ETag listing). "" = skip the asset_hashes upsert (e.g. no transcript).
	TranscriptSHA256 string
}

// Audio kind discriminators for track_audio rows.
const (
	AudioKindOriginal = "original" // the source/published recording
	AudioKindClean    = "clean"    // denoised version produced by the denoiser
)

// AudioRow is one (track, language, kind) row in track_audio — a single audio
// version of a variant. A variant can have several (original, clean, …).
type AudioRow struct {
	TrackID  string
	Language string
	Kind     string // AudioKindOriginal | AudioKindClean | …
	Path     string // relative key, e.g. public/tracks/{id}/audio/original.mp3
	Filesize int64
	Duration int64 // ms
}
