package catalogport

import (
	"context"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// SchemeReader is the narrow surface refresh needs from a freshly-downloaded
// snapshot to verify scheme compatibility. Defining a tiny port keeps the
// application layer (refresh) decoupled from the sqlite adapter.
type SchemeReader interface {
	ReadScheme(ctx context.Context, dbPath string) (int, error)
}

// SchemeAccess exposes the catalog DB's schema version.
type SchemeAccess interface {
	Scheme(ctx context.Context) (int, error)
}

// DictRepository is the dictionary side of the catalog (authors,
// locations, sources, tags). Resolver candidate generation, list/get
// MCP tools, and the dictcrud use case all consume just this slice —
// no need to drag track read/write methods through them.
type DictRepository interface {
	GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error)
	ListDict(ctx context.Context, kind catalog.Kind, opts catalog.ListOpts) ([]catalog.DictEntry, error)
	UsageCount(ctx context.Context, kind catalog.Kind, id string) (int, error)

	// LookupIDByName resolves a canonical name to its dict id in the
	// given language. For author/location/tag the input is matched
	// against `full_name`; for source against `short_name` (filenames
	// carry source codes like "SB"/"BG", not full titles). Returns
	// ok=false when no row matches — caller decides whether to LLM-
	// resolve, auto-create, or fail. This is the single source of
	// truth for "name → id"; the lake registry holds no id state.
	LookupIDByName(ctx context.Context, kind catalog.Kind, name, language string) (id string, ok bool, err error)

	CreateDict(ctx context.Context, kind catalog.Kind, e catalog.DictEntry) (string, error)
	UpdateDictLocale(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error
	DeleteDictLocale(ctx context.Context, kind catalog.Kind, id, language string) error
	DeleteDict(ctx context.Context, kind catalog.Kind, id string) error
}

// TrackRepository is the track side of the catalog (tracks, variants,
// references, tags). The commit use case writes; track_status and the
// list tools read.
type TrackRepository interface {
	GetTrack(ctx context.Context, id string) (catalog.TrackRow, bool, error)
	GetVariant(ctx context.Context, trackID, language string) (catalog.VariantRow, bool, error)
	GetReferences(ctx context.Context, trackID string) ([]catalog.TrackReference, error)
	GetTrackTags(ctx context.Context, trackID string) ([]string, error)

	// SaveTrack performs the atomic UPSERT on tracks + track_variants +
	// track_references + tracks_search FTS row. Returns error if any
	// invariant is violated (e.g. dangling FK).
	SaveTrack(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, refs []catalog.TrackReference) error

	// DeleteTrackVariant removes one (track, language) variant + its
	// FTS rows. If the last variant of a track is removed, also removes
	// the tracks row + references.
	DeleteTrackVariant(ctx context.Context, trackID, language string) error
}

// CommitRepository is the slice the commit use case + its siblings
// (track_set_metadata, audiotag) actually need: full track read/write
// plus GetDict to look up the primary source's short_name when seeding
// the per-locale sort_reference key, plus LookupIDByName to translate
// the metadata payload's canonical *names* (the on-disk format since
// the dict_resolution_cache removal) into catalog ids at commit time.
type CommitRepository interface {
	TrackRepository
	GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error)
	LookupIDByName(ctx context.Context, kind catalog.Kind, name, language string) (id string, ok bool, err error)
}

// Repository is the combined facade — composition root assembles a
// single sqlite implementation and hands it to use cases that want
// access to both sides. New use cases should depend on the narrow
// DictRepository / TrackRepository / SchemeAccess / CommitRepository
// interfaces instead.
type Repository interface {
	SchemeAccess
	DictRepository
	TrackRepository
}

// CollectionRepository is the collection side of the catalog (`collections` +
// `collection_tracks`). Collections are curated, locale-keyed bundles surfaced
// on the library/home surfaces; unlike dicts they are never fuzzy-resolved, so
// the port stays small and is consumed only by the collectioncrud use case.
type CollectionRepository interface {
	CreateCollectionLocale(ctx context.Context, id, language, name string, featured bool, sortOrder int) error
	UpdateCollectionLocale(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error
	GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error)
	ListCollections(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error)
	DeleteCollection(ctx context.Context, id string) error
	DeleteCollectionLocale(ctx context.Context, id, language string) error
	SetCollectionTracks(ctx context.Context, collectionID, language string, trackIDs []string) error
	AddCollectionTrack(ctx context.Context, collectionID, language, trackID string, position *int) error
	RemoveCollectionTrack(ctx context.Context, collectionID, language, trackID string) error
	// TrackLanguages returns the set of languages this track has a
	// `track_variants` row for. The collectioncrud use case uses this to
	// enforce the per-locale invariant: a track may only join a collection
	// whose language matches one of its variants.
	TrackLanguages(ctx context.Context, trackID string) ([]string, error)
}

// Resolver maps a raw extracted string (author/location/source/tag) to an ID
// in the catalog. Implementations: exact (string match) and anthropic (LLM).
type Resolver interface {
	Name() string
	Resolve(ctx context.Context, req ResolveRequest) (ResolveResponse, error)
}

type ResolveRequest struct {
	Kind       catalog.Kind
	Query      string
	Candidates []catalog.DictEntry
	Hint       string // language, date, etc.
}

type ResolveResponse struct {
	MatchedID string // "" when no candidate fits
	// MatchedName is the canonical name that gets persisted in the
	// metadata payload (so commit can look it up against the live
	// catalog rather than relying on a frozen id). For author /
	// location / tag this is `full_name` in the queried language; for
	// source it is `short_name` (filenames carry "SB"/"BG" codes).
	MatchedName string
	Confidence  Confidence
	Reasoning   string
	Provider    string
}

type Confidence string

const (
	ConfExact  Confidence = "exact"
	ConfHigh   Confidence = "high"
	ConfMedium Confidence = "medium"
	ConfLow    Confidence = "low"
	ConfNone   Confidence = "none"
)
