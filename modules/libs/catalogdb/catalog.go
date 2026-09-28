package catalogdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// MigrateCatalog brings a current.db up to the published schema: an empty file
// gets the baseline, an older one every step it has not recorded, each in its
// own transaction and recorded in `migrations`. Run it once when the file is
// opened for writing; readers of a published file never migrate it. The
// search index is an FTS4 table, so the driver must be built with FTS4
// (mattn/go-sqlite3 is; modernc.org/sqlite is not).
//
// Steps that change what an installed client may rely on bump the scheme and
// are recorded with it. Additive steps and content backfills are recorded with
// a NULL scheme, which every scheme reader skips.
func MigrateCatalog(ctx context.Context, db *sql.DB) error {
	return catalogPlan.migrate(ctx, db)
}

var catalogPlan = plan{
	format:   "catalog",
	baseline: catalogBaseline,
	recorded: true,
	steps: []Step{
		{Name: "001_init_schema", Scheme: 20260420},
		{Name: "002_drop_sort_cache", Scheme: 20260512},
		{Name: "003_add_packs", Scheme: 20260520},
		{Name: "004_rename_packs_to_collections", Scheme: 20260613, Up: renamePacksToCollections},
		{Name: "005_add_track_audio", Scheme: 20260614, Up: addTrackAudio},
		{Name: "006_add_settings_and_daily_wisdom", Scheme: 20260621, Up: addSettingsAndDailyWisdom},
		{Name: "008_fold_fts_marks", Up: foldSearchRows},
		{Name: "009_add_collection_groups", Up: addCollectionGroups},
		{Name: "010_add_author_profile", Up: addAuthorProfile},
		{Name: "011_add_track_contributor", Up: addTrackContributor},
		{Name: "012_add_track_variant_outline", Up: addTrackVariantOutline},
		{Name: "013_add_topics", Up: addTopics},
		{Name: "014_add_asset_hashes", Up: addAssetHashes},
		{Name: "015_backfill_combined_search", Up: backfillCombinedSearch},
		{Name: "016_seed_kind_tags", Up: seedKindTags},
		{Name: "017_seed_featured_tag", Up: seedFeaturedTag},
	},
}

// renamePacksToCollections turns the starter packs into collections and gives
// them their current columns and tag membership. SQLite rewrites the child
// table's foreign key when its parent is renamed, so no rebuild is needed.
func renamePacksToCollections(ctx context.Context, tx *sql.Tx) error {
	hasCollections, err := tableExists(ctx, tx, "collections")
	if err != nil {
		return err
	}
	if !hasCollections {
		hasPacks, err := tableExists(ctx, tx, "packs")
		if err != nil {
			return err
		}
		if !hasPacks {
			return errors.New("the file has neither packs nor collections")
		}
		if err := execAll(ctx, tx,
			`ALTER TABLE packs RENAME TO collections`,
			`ALTER TABLE pack_tracks RENAME TO collection_tracks`,
			`ALTER TABLE collection_tracks RENAME COLUMN pack_id TO collection_id`,
			`ALTER TABLE collection_tracks RENAME COLUMN pack_language TO collection_language`,
			`DROP INDEX IF EXISTS idx_pack_tracks_pack`,
		); err != nil {
			return err
		}
	}
	if err := createIndexIfMissing(ctx, tx, ddlCatalogIndexIdxCollectionTracks); err != nil {
		return err
	}
	if err := addColumnsIfMissing(ctx, tx, "collections", "cover", "description", "meta"); err != nil {
		return err
	}
	if err := createTableIfMissing(ctx, tx, "collection_tags", ddlCatalogTableCollectionTags); err != nil {
		return err
	}
	// A pack's `featured` flag became membership in the curation tag.
	hasFeatured, err := columnExists(ctx, tx, "collections", "featured")
	if err != nil || !hasFeatured {
		return err
	}
	return execAll(ctx, tx,
		`INSERT OR IGNORE INTO collection_tags (collection_id, collection_language, tag_id)
		 SELECT id, language, '`+FeaturedTagID+`' FROM collections WHERE featured = 1`,
		`ALTER TABLE collections DROP COLUMN featured`,
	)
}

// addTrackAudio moves audio to one row per (track, language, kind): the file a
// variant already carries becomes its `original` row.
func addTrackAudio(ctx context.Context, tx *sql.Tx) error {
	if err := createTableIfMissing(ctx, tx, "track_audio", ddlCatalogTableTrackAudio,
		ddlCatalogIndexIdxTrackAudioTrack); err != nil {
		return err
	}
	return execAll(ctx, tx,
		`INSERT OR IGNORE INTO track_audio (track_id, language, kind, path, filesize, duration)
		 SELECT track_id, language, 'original', audio_path, audio_filesize, audio_duration
		 FROM track_variants
		 WHERE audio_path IS NOT NULL AND audio_path != ''`)
}

// addSettingsAndDailyWisdom adds the onboarding tables: a key/value settings
// store and the daily-wisdom fragments the mobile proactive rule samples.
func addSettingsAndDailyWisdom(ctx context.Context, tx *sql.Tx) error {
	if err := createTableIfMissing(ctx, tx, "settings", ddlCatalogTableSettings); err != nil {
		return err
	}
	return createTableIfMissing(ctx, tx, "daily_wisdom", ddlCatalogTableDailyWisdom,
		ddlCatalogIndexIdxDailyWisdomTopic)
}

// foldSearchRows rewrites every indexed search row into the folded form the
// writer emits, so a title indexed before folding is reachable by the same
// spellings as one indexed after.
func foldSearchRows(ctx context.Context, tx *sql.Tx) error {
	// Read the index out whole before writing any of it back: updating the
	// table under an open cursor over it is not something to rely on.
	pending, err := unfoldedSearchRows(ctx, tx)
	if err != nil {
		return err
	}
	for _, r := range pending {
		if _, err := tx.ExecContext(ctx,
			`UPDATE tracks_search SET content = ? WHERE rowid = ?`, r.content, r.id); err != nil {
			return fmt.Errorf("fold tracks_search row %d: %w", r.id, err)
		}
	}
	return nil
}

type ftsRow struct {
	id      int64
	content string
}

// unfoldedSearchRows returns the search rows whose content folds differently,
// already folded.
func unfoldedSearchRows(ctx context.Context, tx *sql.Tx) ([]ftsRow, error) {
	rows, err := tx.QueryContext(ctx, `SELECT rowid, content FROM tracks_search`)
	if err != nil {
		return nil, fmt.Errorf("read tracks_search: %w", err)
	}
	defer rows.Close()
	var out []ftsRow
	for rows.Next() {
		var r ftsRow
		if err := rows.Scan(&r.id, &r.content); err != nil {
			return nil, fmt.Errorf("scan tracks_search: %w", err)
		}
		if folded := FoldSearchText(r.content); folded != r.content {
			out = append(out, ftsRow{id: r.id, content: folded})
		}
	}
	return out, rows.Err()
}

func addCollectionGroups(ctx context.Context, tx *sql.Tx) error {
	if err := createTableIfMissing(ctx, tx, "collection_groups", ddlCatalogTableCollectionGroups); err != nil {
		return err
	}
	return createTableIfMissing(ctx, tx, "collection_group_items", ddlCatalogTableCollectionGroupItems,
		ddlCatalogIndexIdxCollectionGroupItems)
}

// addAuthorProfile adds the avatar (an asset key, the same on every locale
// row) and the per-locale bio.
func addAuthorProfile(ctx context.Context, tx *sql.Tx) error {
	return addColumnsIfMissing(ctx, tx, "authors", "image", "description")
}

// addTrackContributor records who contributed a promoted personal-library
// lecture. Attribution only: the corpus has no owners.
func addTrackContributor(ctx context.Context, tx *sql.Tx) error {
	return addColumnsIfMissing(ctx, tx, "tracks", "contributor_user_id")
}

// addTrackVariantOutline adds the lecture overview: a JSON outline of
// {title,start,end} sections and a short per-locale description.
func addTrackVariantOutline(ctx context.Context, tx *sql.Tx) error {
	return addColumnsIfMissing(ctx, tx, "track_variants", "outline", "description")
}

// addTopics adds the recommender's topic dictionary and the weighted
// membership of tracks in topics.
func addTopics(ctx context.Context, tx *sql.Tx) error {
	if err := createTableIfMissing(ctx, tx, "topics", ddlCatalogTableTopics); err != nil {
		return err
	}
	if err := addColumnsIfMissing(ctx, tx, "topics", "short_name", "cover"); err != nil {
		return err
	}
	return createTableIfMissing(ctx, tx, "track_topics", ddlCatalogTableTrackTopics,
		ddlCatalogIndexIdxTrackTopicsTopic)
}

// addAssetHashes adds the content hash of every published asset. The chat
// indexer reads it as its transcript listing, since the CDN has none.
func addAssetHashes(ctx context.Context, tx *sql.Tx) error {
	return createTableIfMissing(ctx, tx, "asset_hashes", ddlCatalogTableAssetHashes,
		ddlCatalogIndexIdxAssetHashesKind)
}

// backfillCombinedSearch indexes a `combined` search row for every track when
// the file has none at all.
func backfillCombinedSearch(ctx context.Context, tx *sql.Tx) error {
	var combined int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tracks_search WHERE kind = 'combined'`).Scan(&combined); err != nil {
		return fmt.Errorf("count combined rows: %w", err)
	}
	if combined > 0 {
		return nil
	}
	ids, err := stringColumn(ctx, tx, `SELECT id FROM tracks ORDER BY id`)
	if err != nil {
		return fmt.Errorf("list tracks: %w", err)
	}
	for _, id := range ids {
		if err := ReindexTrackSearch(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

// KindTag is one of the fixed recording-type tags every catalog carries.
type KindTag struct {
	ID     string
	NameRu string
	NameEn string
}

// KindTags is the fixed set of recording-type tags. Metadata extraction emits
// one of these ids as a track's kind.
var KindTags = []KindTag{
	{"tag_morning_walk", "Утренняя прогулка", "Morning Walk"},
	{"tag_conversation", "Беседа", "Conversation"},
	{"tag_interview", "Интервью", "Interview"},
	{"tag_press_conf", "Пресс-конференция", "Press Conference"},
	{"tag_address", "Речь", "Address"},
	{"tag_vyasa_puja", "Вьяса-пуджа", "Vyāsa-pūjā"},
	{"tag_initiation", "Инициация", "Initiation"},
	{"tag_wedding", "Свадьба", "Wedding"},
	{"tag_festival", "Праздник", "Festival"},
	{"tag_bhajan", "Бхаджан", "Bhajan"},
	{"tag_other", "Прочее", "Misc"},
}

func seedKindTags(ctx context.Context, tx *sql.Tx) error {
	for _, t := range KindTags {
		for _, name := range [][2]string{{"ru", t.NameRu}, {"en", t.NameEn}} {
			if _, err := tx.ExecContext(ctx,
				`INSERT OR IGNORE INTO tags (id, language, full_name) VALUES (?, ?, ?)`,
				t.ID, name[0], name[1]); err != nil {
				return fmt.Errorf("seed %s: %w", t.ID, err)
			}
		}
	}
	return nil
}

// FeaturedTagID is the curation tag that puts a collection on the featured
// shelf.
const FeaturedTagID = "tag_featured"

func seedFeaturedTag(ctx context.Context, tx *sql.Tx) error {
	for _, name := range [][2]string{{"ru", "Рекомендуем"}, {"en", "Featured"}} {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO tags (id, language, full_name) VALUES (?, ?, ?)`,
			FeaturedTagID, name[0], name[1]); err != nil {
			return fmt.Errorf("seed %s: %w", FeaturedTagID, err)
		}
	}
	return nil
}

// ReadScheme returns the scheme a catalog file advertises: the newest named
// migration that carries one. It is the query the mobile app runs at start.
func ReadScheme(ctx context.Context, q Querier) (int, error) {
	var s int
	if err := q.QueryRowContext(ctx,
		`SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1`).Scan(&s); err != nil {
		return 0, fmt.Errorf("read scheme: %w", err)
	}
	return s, nil
}

func indexName(ddl string) (string, error) {
	f := strings.Fields(ddl)
	for i := 0; i+1 < len(f); i++ {
		if strings.EqualFold(f[i], "INDEX") {
			return f[i+1], nil
		}
	}
	return "", fmt.Errorf("no index name in %q", firstLine(ddl))
}

func stringColumn(ctx context.Context, q Querier, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
