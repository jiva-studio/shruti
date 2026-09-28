-- index idx_asset_hashes_kind on asset_hashes
CREATE INDEX idx_asset_hashes_kind ON asset_hashes(kind);

-- index idx_collection_group_items on collection_group_items
CREATE INDEX idx_collection_group_items ON collection_group_items(group_id, group_language, position);

-- index idx_collection_tracks on collection_tracks
CREATE INDEX idx_collection_tracks ON collection_tracks(collection_id, collection_language, position);

-- index idx_daily_wisdom_topic on daily_wisdom
CREATE INDEX idx_daily_wisdom_topic ON daily_wisdom(topic_id, language);

-- index idx_track_audio_track on track_audio
CREATE INDEX idx_track_audio_track
			ON track_audio(track_id, language);

-- index idx_track_references_source on track_references
CREATE INDEX idx_track_references_source ON track_references(source_id);

-- index idx_track_topics_topic on track_topics
CREATE INDEX idx_track_topics_topic
			ON track_topics(topic_id, weight DESC);

-- index idx_track_variants_language on track_variants
CREATE INDEX idx_track_variants_language ON track_variants(language);

-- index idx_track_variants_sort_reference on track_variants
CREATE INDEX idx_track_variants_sort_reference
  ON track_variants(language, sort_reference);

-- index idx_tracks_author on tracks
CREATE INDEX idx_tracks_author         ON tracks(author_id);

-- index idx_tracks_location on tracks
CREATE INDEX idx_tracks_location       ON tracks(location_id);

-- index sqlite_autoindex_asset_hashes_1 on asset_hashes

-- index sqlite_autoindex_authors_1 on authors

-- index sqlite_autoindex_collection_group_items_1 on collection_group_items

-- index sqlite_autoindex_collection_groups_1 on collection_groups

-- index sqlite_autoindex_collection_tags_1 on collection_tags

-- index sqlite_autoindex_collection_tracks_1 on collection_tracks

-- index sqlite_autoindex_collections_1 on collections

-- index sqlite_autoindex_daily_wisdom_1 on daily_wisdom

-- index sqlite_autoindex_languages_1 on languages

-- index sqlite_autoindex_locations_1 on locations

-- index sqlite_autoindex_migrations_1 on migrations

-- index sqlite_autoindex_settings_1 on settings

-- index sqlite_autoindex_sources_1 on sources

-- index sqlite_autoindex_tags_1 on tags

-- index sqlite_autoindex_topics_1 on topics

-- index sqlite_autoindex_track_audio_1 on track_audio

-- index sqlite_autoindex_track_references_1 on track_references

-- index sqlite_autoindex_track_tags_1 on track_tags

-- index sqlite_autoindex_track_topics_1 on track_topics

-- index sqlite_autoindex_track_variants_1 on track_variants

-- index sqlite_autoindex_tracks_1 on tracks

-- index sqlite_autoindex_tracks_search_segdir_1 on tracks_search_segdir

-- table asset_hashes on asset_hashes
CREATE TABLE asset_hashes (
			path TEXT NOT NULL PRIMARY KEY, sha256 TEXT NOT NULL,
			track_id TEXT, language TEXT, kind TEXT);

-- table authors on authors
CREATE TABLE authors (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL, image TEXT, description TEXT,
  PRIMARY KEY (id, language)
);

-- table collection_group_items on collection_group_items
CREATE TABLE collection_group_items (
			group_id        TEXT NOT NULL,
			group_language  TEXT NOT NULL,
			collection_id   TEXT NOT NULL,
			position        INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (group_id, group_language, collection_id),
			FOREIGN KEY (group_id, group_language) REFERENCES collection_groups(id, language) ON DELETE CASCADE
		);

-- table collection_groups on collection_groups
CREATE TABLE collection_groups (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			description TEXT,
			meta        TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language)
		);

-- table collection_tags on collection_tags
CREATE TABLE collection_tags (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			tag_id               TEXT NOT NULL,
			PRIMARY KEY (collection_id, collection_language, tag_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES collections(id, language) ON DELETE CASCADE
		);

-- table collection_tracks on collection_tracks
CREATE TABLE "collection_tracks" (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			track_id       TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (collection_id, collection_language, track_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES "collections"(id, language) ON DELETE CASCADE
		);

-- table collections on collections
CREATE TABLE "collections" (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			sort_order  INTEGER NOT NULL DEFAULT 0, cover TEXT, description TEXT, meta TEXT,
			PRIMARY KEY (id, language)
		);

-- table daily_wisdom on daily_wisdom
CREATE TABLE daily_wisdom (
			id         TEXT NOT NULL PRIMARY KEY,
			track_id   TEXT NOT NULL,
			language   TEXT NOT NULL,
			start_ms   INTEGER NOT NULL,
			end_ms     INTEGER NOT NULL,
			text       TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		);

-- table languages on languages
CREATE TABLE languages (
  code      TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  icon      TEXT
);

-- table locations on locations
CREATE TABLE locations (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

-- table migrations on migrations
CREATE TABLE migrations (
  name       TEXT PRIMARY KEY,
  scheme     INTEGER,
  applied_at INTEGER NOT NULL
);

-- table settings on settings
CREATE TABLE settings (
			key        TEXT NOT NULL PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		);

-- table sources on sources
CREATE TABLE sources (
  id         TEXT NOT NULL,
  language   TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  short_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

-- table tags on tags
CREATE TABLE tags (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

-- table topics on topics
CREATE TABLE topics (
			id         TEXT NOT NULL,
			language   TEXT NOT NULL,
			full_name  TEXT NOT NULL, short_name TEXT, cover TEXT,
			PRIMARY KEY (id, language)
		);

-- table track_audio on track_audio
CREATE TABLE track_audio (
			track_id  TEXT    NOT NULL,
			language  TEXT    NOT NULL,
			kind      TEXT    NOT NULL,            -- original | clean | ...
			path      TEXT    NOT NULL,
			filesize  INTEGER,
			duration  INTEGER,                     -- milliseconds
			PRIMARY KEY (track_id, language, kind),
			FOREIGN KEY (track_id, language)
				REFERENCES track_variants(track_id, language) ON DELETE CASCADE
		);

-- table track_references on track_references
CREATE TABLE track_references (
  track_id  TEXT NOT NULL,
  ref_idx   INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  PRIMARY KEY (track_id, ref_idx)
);

-- table track_tags on track_tags
CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
);

-- table track_topics on track_topics
CREATE TABLE track_topics (
			track_id   TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			weight     REAL NOT NULL,
			PRIMARY KEY (track_id, topic_id)
		);

-- table track_variants on track_variants
CREATE TABLE track_variants (
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
);

-- table tracks on tracks
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  -- author/location may be unknown in legacy content (especially on
  -- older recordings without metadata). Keep them nullable; the app
  -- renders a fallback when they're missing.
  author_id       TEXT,
  location_id     TEXT,
  date            TEXT,              -- ISO "YYYY-MM-DD", e.g. "1974-10-20"
  hidden          INTEGER NOT NULL DEFAULT 0, contributor_user_id TEXT);

-- table tracks_search on tracks_search
CREATE VIRTUAL TABLE tracks_search USING fts4(
  content,
  track_id,
  kind,
  notindexed="track_id",
  notindexed="kind",
  tokenize=unicode61 "remove_diacritics=2"
);

-- table tracks_search_content on tracks_search_content
CREATE TABLE 'tracks_search_content'(docid INTEGER PRIMARY KEY, 'c0content', 'c1track_id', 'c2kind');

-- table tracks_search_docsize on tracks_search_docsize
CREATE TABLE 'tracks_search_docsize'(docid INTEGER PRIMARY KEY, size BLOB);

-- table tracks_search_segdir on tracks_search_segdir
CREATE TABLE 'tracks_search_segdir'(level INTEGER,idx INTEGER,start_block INTEGER,leaves_end_block INTEGER,end_block INTEGER,root BLOB,PRIMARY KEY(level, idx));

-- table tracks_search_segments on tracks_search_segments
CREATE TABLE 'tracks_search_segments'(blockid INTEGER PRIMARY KEY, block BLOB);

-- table tracks_search_stat on tracks_search_stat
CREATE TABLE 'tracks_search_stat'(id INTEGER PRIMARY KEY, value BLOB);

