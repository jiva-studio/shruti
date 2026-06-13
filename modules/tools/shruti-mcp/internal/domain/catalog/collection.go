package catalog

// KindCollection identifies the starter-collection entity. Collections are curated, named
// bundles of track ids surfaced to users on empty-state screens (mobile
// Home). Schema mirrors the dict pattern — a logical collection has one row
// per locale in `collections`, plus an ordered list of track ids in
// `collection_tracks`. Unlike dicts, collections are never fuzzy-resolved.
const KindCollection Kind = "collection"

// CollectionIDPrefix is the catalog ID prefix for collections (`pack_<12 alnum>`),
// matching the established author/location/source/track pattern.
const CollectionIDPrefix = "pack_"

// Collection is one starter-collection collapsed across locales.
//
//	Names      : language → name (one row per locale in `collections`)
//	Featured   : language → 1/0 (per-locale visibility on Home)
//	SortOrder  : language → ASC chip-ordering key
//
// Per-locale `featured` / `sort_order` follow the same ergonomics as
// the dict-table-per-locale shape: editors can ship one locale ahead
// of the other or hide one while the other stays public.
type Collection struct {
	Id        string
	Names     map[string]string
	Featured  map[string]bool
	SortOrder map[string]int
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
	Featured *bool
	Limit    int
	Cursor   string
}
