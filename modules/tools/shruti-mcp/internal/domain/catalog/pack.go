package catalog

// KindPack identifies the starter-pack entity. Packs are curated, named
// bundles of track ids surfaced to users on empty-state screens (mobile
// Home). Schema mirrors the dict pattern — a logical pack has one row
// per locale in `packs`, plus an ordered list of track ids in
// `pack_tracks`. Unlike dicts, packs are never fuzzy-resolved.
const KindPack Kind = "pack"

// PackIDPrefix is the catalog ID prefix for packs (`pack_<12 alnum>`),
// matching the established author/location/source/track pattern.
const PackIDPrefix = "pack_"

// Pack is one starter-pack collapsed across locales.
//
//	Names      : language → name (one row per locale in `packs`)
//	Featured   : language → 1/0 (per-locale visibility on Home)
//	SortOrder  : language → ASC chip-ordering key
//
// Per-locale `featured` / `sort_order` follow the same ergonomics as
// the dict-table-per-locale shape: editors can ship one locale ahead
// of the other or hide one while the other stays public.
type Pack struct {
	Id        string
	Names     map[string]string
	Featured  map[string]bool
	SortOrder map[string]int
}

// PackTrack is one ordered membership row in `pack_tracks`.
type PackTrack struct {
	PackID       string
	PackLanguage string
	TrackID      string
	Position     int
}

// PackListOpts narrows `pack.list` results.
type PackListOpts struct {
	Language *string
	Featured *bool
	Limit    int
	Cursor   string
}
