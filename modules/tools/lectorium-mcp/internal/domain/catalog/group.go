package catalog

// KindCollectionGroup identifies the collection-group entity — a named, ordered
// shelf of collections (e.g. "Для начинающих", "Бхакти-шастры"). Mirrors the
// collection shape: one row per locale in `collection_groups`, an ordered list
// of collection ids per locale in `collection_group_items`.
const KindCollectionGroup Kind = "collection_group"

// CollectionGroupIDPrefix is the catalog ID prefix for groups (`group_<12 alnum>`).
const CollectionGroupIDPrefix = "group_"

// CollectionGroup is one group collapsed across locales.
//
//	Names        : language → name (one row per locale in `collection_groups`)
//	Descriptions : language → description (may be "")
//	Meta         : language → raw JSON blob for forward-compatible fields (may be "")
//	SortOrder    : language → ASC ordering key on the browse surface
type CollectionGroup struct {
	ID           string
	Names        map[string]string
	Descriptions map[string]string
	Meta         map[string]string
	SortOrder    map[string]int
}

// CollectionGroupItem is one ordered membership row in `collection_group_items`.
type CollectionGroupItem struct {
	GroupID       string
	GroupLanguage string
	CollectionID  string
	Position      int
}

// CollectionGroupListOpts narrows `collection_group.list` results.
type CollectionGroupListOpts struct {
	Language *string
	Limit    int
	Cursor   string
}
