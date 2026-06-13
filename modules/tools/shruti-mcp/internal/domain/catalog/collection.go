package catalog

// KindCollection identifies the collection entity. Collections are curated,
// named, ordered bundles of track ids surfaced to users on the library / home
// surfaces. Schema mirrors the dict pattern — a logical collection has one row
// per locale in `collections`, an ordered track list in `collection_tracks`,
// and per-locale tag membership in `collection_tags`. Unlike dicts, collections
// are never fuzzy-resolved.
const KindCollection Kind = "collection"

// CollectionIDPrefix is the catalog ID prefix for collections. The literal
// `pack_` value is retained from the entity's former name so existing ids stay
// valid without a data rewrite.
const CollectionIDPrefix = "pack_"

// FeaturedTagID is the curation tag a collection carries to surface on the
// mobile home/library. "Featured" is modelled as a tag (in `collection_tags`)
// rather than a column so additional curated shelves can be added later via
// other tags without a schema change.
const FeaturedTagID = "tag_featured"

// Collection is one collection collapsed across locales.
//
//	Names        : language → name (one row per locale in `collections`)
//	Descriptions : language → description (may be "")
//	Covers       : language → S3 asset key (e.g. public/collections/<id>/cover.jpg; may be "")
//	Meta         : language → raw JSON blob for forward-compatible fields (may be "")
//	SortOrder    : language → ASC ordering key
//	TagIDs       : language → tag ids from `collection_tags` (e.g. tag_featured)
//
// Per-locale fields follow the dict-table-per-locale ergonomics: editors can
// ship one locale ahead of the other or curate them independently.
type Collection struct {
	Id           string
	Names        map[string]string
	Descriptions map[string]string
	Covers       map[string]string
	Meta         map[string]string
	SortOrder    map[string]int
	TagIDs       map[string][]string
}

// CollectionTrack is one ordered membership row in `collection_tracks`.
type CollectionTrack struct {
	CollectionID       string
	CollectionLanguage string
	TrackID            string
	Position           int
}

// CollectionListOpts narrows `collection.list` results.
type CollectionListOpts struct {
	Language *string
	// Tag, when set, keeps only collections carrying that tag id in
	// `collection_tags` (e.g. tag_featured for the home shelf).
	Tag    *string
	Limit  int
	Cursor string
}
