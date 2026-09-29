package catalogdb

// The published current.db schema, statement by statement, exactly as
// sqlite_master holds it in the file clients download. A fresh catalog is
// built from these texts, so its schema is byte-identical to the published
// one; the migration steps reuse them to create a table a file lacks.

const (
	ddlCatalogTableAssetHashes = `CREATE TABLE asset_hashes (
			path TEXT NOT NULL PRIMARY KEY, sha256 TEXT NOT NULL,
			track_id TEXT, language TEXT, kind TEXT)`

	ddlCatalogTableAuthors = `CREATE TABLE authors (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL, image TEXT, description TEXT,
  PRIMARY KEY (id, language)
)`

	ddlCatalogTableCollectionGroupItems = `CREATE TABLE collection_group_items (
			group_id        TEXT NOT NULL,
			group_language  TEXT NOT NULL,
			collection_id   TEXT NOT NULL,
			position        INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (group_id, group_language, collection_id),
			FOREIGN KEY (group_id, group_language) REFERENCES collection_groups(id, language) ON DELETE CASCADE
		)`

	ddlCatalogTableCollectionGroups = `CREATE TABLE collection_groups (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			description TEXT,
			meta        TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language)
		)`

	ddlCatalogTableCollectionTags = `CREATE TABLE collection_tags (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			tag_id               TEXT NOT NULL,
			PRIMARY KEY (collection_id, collection_language, tag_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES collections(id, language) ON DELETE CASCADE
		)`

	ddlCatalogTableCollectionTracks = `CREATE TABLE "collection_tracks" (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			track_id       TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (collection_id, collection_language, track_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES "collections"(id, language) ON DELETE CASCADE
		)`

	ddlCatalogTableCollections = `CREATE TABLE "collections" (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			sort_order  INTEGER NOT NULL DEFAULT 0, cover TEXT, description TEXT, meta TEXT,
			PRIMARY KEY (id, language)
		)`

	ddlCatalogTableDailyWisdom = `CREATE TABLE daily_wisdom (
			id         TEXT NOT NULL PRIMARY KEY,
			track_id   TEXT NOT NULL,
			language   TEXT NOT NULL,
			start_ms   INTEGER NOT NULL,
			end_ms     INTEGER NOT NULL,
			text       TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		)`

	ddlCatalogTableLanguages = `CREATE TABLE languages (
  code      TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  icon      TEXT
)`

	ddlCatalogTableLocations = `CREATE TABLE locations (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
)`

	ddlCatalogTableMigrations = `CREATE TABLE migrations (
  name       TEXT PRIMARY KEY,
  scheme     INTEGER,
  applied_at INTEGER NOT NULL
)`

	ddlCatalogTableSettings = `CREATE TABLE settings (
			key        TEXT NOT NULL PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		)`

	ddlCatalogTableSources = `CREATE TABLE sources (
  id         TEXT NOT NULL,
  language   TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  short_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
)`

	ddlCatalogTableTags = `CREATE TABLE tags (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
)`

	ddlCatalogTableTopics = `CREATE TABLE topics (
			id         TEXT NOT NULL,
			language   TEXT NOT NULL,
			full_name  TEXT NOT NULL, short_name TEXT, cover TEXT,
			PRIMARY KEY (id, language)
		)`

	ddlCatalogTableTrackAudio = `CREATE TABLE track_audio (
			track_id  TEXT    NOT NULL,
			language  TEXT    NOT NULL,
			kind      TEXT    NOT NULL,            -- original | clean | ...
			path      TEXT    NOT NULL,
			filesize  INTEGER,
			duration  INTEGER,                     -- milliseconds
			PRIMARY KEY (track_id, language, kind),
			FOREIGN KEY (track_id, language)
				REFERENCES track_variants(track_id, language) ON DELETE CASCADE
		)`

	ddlCatalogTableTrackReferences = `CREATE TABLE track_references (
  track_id  TEXT NOT NULL,
  ref_idx   INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  PRIMARY KEY (track_id, ref_idx)
)`

	ddlCatalogTableTrackTags = `CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
)`

	ddlCatalogTableTrackTopics = `CREATE TABLE track_topics (
			track_id   TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			weight     REAL NOT NULL,
			PRIMARY KEY (track_id, topic_id)
		)`

	ddlCatalogTableTrackVariants = `CREATE TABLE track_variants (
  track_id         TEXT NOT NULL,
  language         TEXT NOT NULL,
  title            TEXT NOT NULL COLLATE NOCASE,
  audio_path       TEXT,
  audio_filesize   INTEGER,
  audio_duration   INTEGER,
  audio_kind       TEXT CHECK (audio_kind IN ('original','generated','edited')),
  transcript_path  TEXT,
  transcript_kind  TEXT CHECK (transcript_kind IN ('original','generated','edited')), sort_reference TEXT, outline TEXT, description TEXT,
  PRIMARY KEY (track_id, language)
)`

	ddlCatalogTableTracks = `CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  -- author/location may be unknown in legacy content (especially on
  -- older recordings without metadata). Keep them nullable; the app
  -- renders a fallback when they're missing.
  author_id       TEXT,
  location_id     TEXT,
  date            TEXT,              -- ISO "YYYY-MM-DD", e.g. "1974-10-20"
  hidden          INTEGER NOT NULL DEFAULT 0, contributor_user_id TEXT)`

	ddlCatalogTableTracksSearch = `CREATE VIRTUAL TABLE tracks_search USING fts4(
  content,
  track_id,
  kind,
  notindexed="track_id",
  notindexed="kind",
  tokenize=unicode61 "remove_diacritics=2"
)`

	ddlCatalogIndexIdxAssetHashesKind = `CREATE INDEX idx_asset_hashes_kind ON asset_hashes(kind)`

	ddlCatalogIndexIdxCollectionGroupItems = `CREATE INDEX idx_collection_group_items ON collection_group_items(group_id, group_language, position)`

	ddlCatalogIndexIdxCollectionTracks = `CREATE INDEX idx_collection_tracks ON collection_tracks(collection_id, collection_language, position)`

	ddlCatalogIndexIdxDailyWisdomTopic = `CREATE INDEX idx_daily_wisdom_topic ON daily_wisdom(topic_id, language)`

	ddlCatalogIndexIdxTrackAudioTrack = `CREATE INDEX idx_track_audio_track
			ON track_audio(track_id, language)`

	ddlCatalogIndexIdxTrackReferencesSource = `CREATE INDEX idx_track_references_source ON track_references(source_id)`

	ddlCatalogIndexIdxTrackTopicsTopic = `CREATE INDEX idx_track_topics_topic
			ON track_topics(topic_id, weight DESC)`

	ddlCatalogIndexIdxTrackVariantsLanguage = `CREATE INDEX idx_track_variants_language ON track_variants(language)`

	ddlCatalogIndexIdxTrackVariantsSortReference = `CREATE INDEX idx_track_variants_sort_reference
  ON track_variants(language, sort_reference)`

	ddlCatalogIndexIdxTracksAuthor = `CREATE INDEX idx_tracks_author         ON tracks(author_id)`

	ddlCatalogIndexIdxTracksLocation = `CREATE INDEX idx_tracks_location       ON tracks(location_id)`
)

var catalogBaseline = []string{
	ddlCatalogTableAssetHashes,
	ddlCatalogTableAuthors,
	ddlCatalogTableCollectionGroupItems,
	ddlCatalogTableCollectionGroups,
	ddlCatalogTableCollectionTags,
	ddlCatalogTableCollectionTracks,
	ddlCatalogTableCollections,
	ddlCatalogTableDailyWisdom,
	ddlCatalogTableLanguages,
	ddlCatalogTableLocations,
	ddlCatalogTableMigrations,
	ddlCatalogTableSettings,
	ddlCatalogTableSources,
	ddlCatalogTableTags,
	ddlCatalogTableTopics,
	ddlCatalogTableTrackAudio,
	ddlCatalogTableTrackReferences,
	ddlCatalogTableTrackTags,
	ddlCatalogTableTrackTopics,
	ddlCatalogTableTrackVariants,
	ddlCatalogTableTracks,
	ddlCatalogTableTracksSearch,
	ddlCatalogIndexIdxAssetHashesKind,
	ddlCatalogIndexIdxCollectionGroupItems,
	ddlCatalogIndexIdxCollectionTracks,
	ddlCatalogIndexIdxDailyWisdomTopic,
	ddlCatalogIndexIdxTrackAudioTrack,
	ddlCatalogIndexIdxTrackReferencesSource,
	ddlCatalogIndexIdxTrackTopicsTopic,
	ddlCatalogIndexIdxTrackVariantsLanguage,
	ddlCatalogIndexIdxTrackVariantsSortReference,
	ddlCatalogIndexIdxTracksAuthor,
	ddlCatalogIndexIdxTracksLocation,
}
