package sqlitecatalog

import (
	"context"
	"database/sql"
	"fmt"
)

// applyLocalMigrations seeds the canonical kind-tag rows and rebuilds the
// FTS combined-row index when missing. Schema is otherwise expected to
// already match `SupportedDBScheme` — the publisher owns schema; the
// client only opens.
func applyLocalMigrations(ctx context.Context, db *sql.DB) error {
	if err := ensureCollectionTables(ctx, db); err != nil {
		return fmt.Errorf("ensure collection tables: %w", err)
	}
	if err := ensureTrackAudioTable(ctx, db); err != nil {
		return fmt.Errorf("ensure track_audio table: %w", err)
	}
	if err := seedKindTags(ctx, db); err != nil {
		return fmt.Errorf("seed kind tags: %w", err)
	}
	if err := backfillCombinedFtsRows(ctx, db); err != nil {
		return fmt.Errorf("backfill combined fts: %w", err)
	}
	if err := ensureAuthorProfileColumns(ctx, db); err != nil {
		return fmt.Errorf("ensure author profile columns: %w", err)
	}
	if err := ensureTrackVariantOutlineColumns(ctx, db); err != nil {
		return fmt.Errorf("ensure track_variant outline columns: %w", err)
	}
	if err := ensureTopicsTables(ctx, db); err != nil {
		return fmt.Errorf("ensure topics tables: %w", err)
	}
	if err := ensureKeyValueTable(ctx, db); err != nil {
		return fmt.Errorf("ensure key_value table: %w", err)
	}
	if err := ensureDailyWisdomTable(ctx, db); err != nil {
		return fmt.Errorf("ensure daily_wisdom table: %w", err)
	}
	return nil
}

// ensureDailyWisdomTable creates the daily-wisdom corpus: one row is a short,
// playable lecture fragment (track + [start,end] ms + excerpt text) tied to a
// topic. The mobile "daily wisdom" proactive rule samples a row for one of the
// user's chosen topics and posts it into chat as a playable cite.
//
// Additive under the SAME scheme — older binaries never query it. Idempotent.
func ensureDailyWisdomTable(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS daily_wisdom (
			id         TEXT NOT NULL PRIMARY KEY,
			track_id   TEXT NOT NULL,
			language   TEXT NOT NULL,
			start_ms   INTEGER NOT NULL,
			end_ms     INTEGER NOT NULL,
			text       TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_daily_wisdom_topic ON daily_wisdom(topic_id, language)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", s, err)
		}
	}
	return nil
}

// ensureKeyValueTable creates a general-purpose settings store: one row per
// config key, value an opaque (usually JSON) string. The onboarding topic
// picker reads `onboarding.topics` from here; the MCP `config.*` tools write
// it (validated against a registry).
//
// It lives in the DB rather than config.json deliberately: the client bundles
// and downloads current.db anyway, so the curated list is available offline
// without a second network fetch. Additive under the SAME scheme — older
// binaries never query it; newer ones read it defensively (missing table →
// fallback). Idempotent.
func ensureKeyValueTable(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS key_value (
			key        TEXT NOT NULL PRIMARY KEY,
			value      TEXT NOT NULL,
			updated_at INTEGER NOT NULL DEFAULT (CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
		)`); err != nil {
		return fmt.Errorf("create key_value: %w", err)
	}
	return nil
}

// ensureTopicsTables creates the recommender's topic vocabulary + membership
// tables when missing:
//   - topics       : the localization dictionary (one row per language),
//     shaped like `tags` so the generic dictcrud path drives it;
//   - track_topics : language-agnostic membership of a track in a topic, with a
//     salience weight (a track covers several topics, each weighted).
//
// Additive tables under the SAME scheme (20260614) — no new `migrations` row,
// mirroring the additive outline columns. Older binaries simply never query
// them; the topics-capable client always pairs (via the scheme gate) with a DB
// that has them. Idempotent.
func ensureTopicsTables(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS topics (
			id         TEXT NOT NULL,
			language   TEXT NOT NULL,
			full_name  TEXT NOT NULL,
			PRIMARY KEY (id, language)
		)`,
		`CREATE TABLE IF NOT EXISTS track_topics (
			track_id   TEXT NOT NULL,
			topic_id   TEXT NOT NULL,
			weight     REAL NOT NULL,
			PRIMARY KEY (track_id, topic_id)
		)`,
		// Reverse lookup for the "tracks by topic" shelf: highest-weight first.
		`CREATE INDEX IF NOT EXISTS idx_track_topics_topic
			ON track_topics(topic_id, weight DESC)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", s, err)
		}
	}
	// Additive per-topic columns (same scheme): a short display name for tight
	// surfaces (chips, shelf headers) and a generated cover key. Older binaries
	// ignore them; mobile reads them when present.
	for _, col := range []string{"short_name", "cover"} {
		has, err := columnExists(ctx, db, "topics", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.ExecContext(ctx,
				fmt.Sprintf(`ALTER TABLE topics ADD COLUMN %s TEXT`, col)); err != nil {
				return fmt.Errorf("add topics.%s: %w", col, err)
			}
		}
	}
	return nil
}

// ensureTrackAudioTable creates the `track_audio` table and backfills it from
// the legacy single-audio columns on track_variants, then records the migration
// so the mobile scheme-validator accepts the freshly-published current.db.
//
// track_audio holds N audio versions per (track, language) — `kind` ∈
// {original, clean, …} — instead of one fixed audio_path on track_variants.
// The pre-existing published file becomes the `original` row; the denoiser adds
// a `clean` row. IF NOT EXISTS + INSERT OR IGNORE keep this idempotent against
// repeat open() calls and already-migrated catalogs.
func ensureTrackAudioTable(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS track_audio (
			track_id  TEXT    NOT NULL,
			language  TEXT    NOT NULL,
			kind      TEXT    NOT NULL,            -- original | clean | ...
			path      TEXT    NOT NULL,
			filesize  INTEGER,
			duration  INTEGER,                     -- milliseconds
			PRIMARY KEY (track_id, language, kind),
			FOREIGN KEY (track_id, language)
				REFERENCES track_variants(track_id, language) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_track_audio_track
			ON track_audio(track_id, language)`,
		// Backfill: every variant that currently has audio becomes its 'original' row.
		`INSERT OR IGNORE INTO track_audio (track_id, language, kind, path, filesize, duration)
			SELECT track_id, language, 'original', audio_path, audio_filesize, audio_duration
			FROM track_variants
			WHERE audio_path IS NOT NULL AND audio_path != ''`,
		// Numbered migration row so the mobile SchemeReader (ORDER BY name DESC
		// LIMIT 1) sees the bumped scheme. '005_' sorts after collections'
		// '004_rename_packs_to_collections', so this scheme (20260614) wins.
		`INSERT OR IGNORE INTO migrations (name, scheme, applied_at)
		 VALUES ('005_add_track_audio', 20260614, CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", s, err)
		}
	}
	return nil
}

// ensureAuthorProfileColumns adds the author avatar/bio columns when missing:
//   - image       : S3 asset key for the avatar, language-neutral (same value
//     on every locale row);
//   - description : a short per-locale bio.
//
// Additive ALTERs under the same scheme — older mobile binaries ignore the new
// columns, newer ones read them. Idempotent: a no-op once present.
func ensureAuthorProfileColumns(ctx context.Context, db *sql.DB) error {
	for _, col := range []string{"image", "description"} {
		has, err := columnExists(ctx, db, "authors", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.ExecContext(ctx,
				fmt.Sprintf(`ALTER TABLE authors ADD COLUMN %s TEXT`, col)); err != nil {
				return fmt.Errorf("add authors.%s: %w", col, err)
			}
		}
	}
	return nil
}

// ensureTrackVariantOutlineColumns adds the per-variant lecture-overview columns
// when missing:
//   - outline     : JSON array of {title,start,end} section headings (ms),
//     generated from the reviewed transcript;
//   - description : a short per-locale overview of the lecture.
//
// Additive ALTERs under the same scheme — older mobile binaries ignore the new
// columns, newer ones read them. Idempotent: a no-op once present.
func ensureTrackVariantOutlineColumns(ctx context.Context, db *sql.DB) error {
	for _, col := range []string{"outline", "description"} {
		has, err := columnExists(ctx, db, "track_variants", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.ExecContext(ctx,
				fmt.Sprintf(`ALTER TABLE track_variants ADD COLUMN %s TEXT`, col)); err != nil {
				return fmt.Errorf("add track_variants.%s: %w", col, err)
			}
		}
	}
	return nil
}

// ensureCollectionTables guarantees the `collections` / `collection_tracks`
// schema exists and records the migration row so the mobile scheme-validator
// (which reads scheme from migrations ORDER BY name DESC LIMIT 1) accepts the
// freshly-published current.db.
//
// The catalog `current.db` is a binary snapshot mutated in place — there is no
// rebuild-from-DDL path — so the historical `packs` → `collections` rename is
// applied here as a migration-on-open: if the legacy `packs` table is present
// and `collections` is not, rename it in place. Idempotent: once `collections`
// exists, this is a no-op apart from the INSERT OR IGNORE migrations row.
func ensureCollectionTables(ctx context.Context, db *sql.DB) error {
	hasCollections, err := tableExists(ctx, db, "collections")
	if err != nil {
		return err
	}
	if !hasCollections {
		hasPacks, err := tableExists(ctx, db, "packs")
		if err != nil {
			return err
		}
		if hasPacks {
			if err := renamePacksToCollections(ctx, db); err != nil {
				return fmt.Errorf("rename packs to collections: %w", err)
			}
		} else if err := createCollectionTables(ctx, db); err != nil {
			return fmt.Errorf("create collection tables: %w", err)
		}
	}
	if err := finalizeCollectionSchema(ctx, db); err != nil {
		return fmt.Errorf("finalize collection schema: %w", err)
	}
	// Bumped scheme: the table rename is breaking for old binaries, so the
	// scheme moves to 20260613 (mirrors scheme.go / db-scheme.json). The name
	// sorts after the legacy '003_add_packs' row so the SchemeReader picks it.
	if _, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO migrations (name, scheme, applied_at)
		 VALUES ('004_rename_packs_to_collections', 20260613, CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))`); err != nil {
		return fmt.Errorf("record migration row: %w", err)
	}
	return nil
}

func tableExists(ctx context.Context, db *sql.DB, name string) (bool, error) {
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).
		Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// renamePacksToCollections renames the legacy starter-pack tables in place.
// SQLite (>= 3.25) auto-updates the child FK reference when the parent table
// is renamed and the FK local columns when those columns are renamed, so no
// rebuild is needed for the rename alone.
func renamePacksToCollections(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []string{
		`ALTER TABLE packs RENAME TO collections`,
		`ALTER TABLE pack_tracks RENAME TO collection_tracks`,
		`ALTER TABLE collection_tracks RENAME COLUMN pack_id TO collection_id`,
		`ALTER TABLE collection_tracks RENAME COLUMN pack_language TO collection_language`,
		`DROP INDEX IF EXISTS idx_pack_tracks_pack`,
		`CREATE INDEX IF NOT EXISTS idx_collection_tracks ON collection_tracks(collection_id, collection_language, position)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", s, err)
		}
	}
	return tx.Commit()
}

// createCollectionTables builds the final schema from scratch. In production
// the catalog always ships with the tables already present (legacy `packs` or
// the renamed `collections`), so this path is only exercised by fresh test DBs.
// The shared shape (new columns, collection_tags) is guaranteed by
// finalizeCollectionSchema, which runs on every open.
func createCollectionTables(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS collections (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			cover       TEXT,
			description TEXT,
			meta        TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language)
		)`,
		`CREATE TABLE IF NOT EXISTS collection_tracks (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			track_id             TEXT NOT NULL,
			position             INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (collection_id, collection_language, track_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES collections(id, language) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_collection_tracks ON collection_tracks(collection_id, collection_language, position)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", s, err)
		}
	}
	return nil
}

// finalizeCollectionSchema brings the `collections` table to its current shape
// regardless of origin — freshly created or renamed from legacy `packs`:
//   - adds the cover / description / meta columns when missing;
//   - creates the `collection_tags` membership table;
//   - seeds the `tag_featured` curation tag;
//   - migrates a legacy `featured` column to a tag_featured membership in
//     `collection_tags`, then drops the column.
//
// Idempotent: on an already-final schema every step is a no-op.
func finalizeCollectionSchema(ctx context.Context, db *sql.DB) error {
	for _, col := range []string{"cover", "description", "meta"} {
		has, err := columnExists(ctx, db, "collections", col)
		if err != nil {
			return err
		}
		if !has {
			if _, err := db.ExecContext(ctx,
				fmt.Sprintf(`ALTER TABLE collections ADD COLUMN %s TEXT`, col)); err != nil {
				return fmt.Errorf("add column %s: %w", col, err)
			}
		}
	}

	if _, err := db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS collection_tags (
			collection_id        TEXT NOT NULL,
			collection_language  TEXT NOT NULL,
			tag_id               TEXT NOT NULL,
			PRIMARY KEY (collection_id, collection_language, tag_id),
			FOREIGN KEY (collection_id, collection_language) REFERENCES collections(id, language) ON DELETE CASCADE
		)`); err != nil {
		return fmt.Errorf("create collection_tags: %w", err)
	}

	// Collection groups — named, ordered shelves of collections (additive;
	// older clients ignore them, newer clients read them gracefully).
	for _, s := range []string{
		`CREATE TABLE IF NOT EXISTS collection_groups (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			description TEXT,
			meta        TEXT,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language)
		)`,
		`CREATE TABLE IF NOT EXISTS collection_group_items (
			group_id        TEXT NOT NULL,
			group_language  TEXT NOT NULL,
			collection_id   TEXT NOT NULL,
			position        INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (group_id, group_language, collection_id),
			FOREIGN KEY (group_id, group_language) REFERENCES collection_groups(id, language) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_collection_group_items ON collection_group_items(group_id, group_language, position)`,
	} {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("create collection group tables: %w", err)
		}
	}

	// Seed the curation tag. `tags` is part of the canonical published schema.
	// (Literal kept here — migrations are schema snapshots; mirrors catalog.FeaturedTagID.)
	for _, t := range []struct{ lang, name string }{{"ru", "Рекомендуем"}, {"en", "Featured"}} {
		if _, err := db.ExecContext(ctx,
			`INSERT OR IGNORE INTO tags (id, language, full_name) VALUES ('tag_featured', ?, ?)`,
			t.lang, t.name); err != nil {
			return fmt.Errorf("seed featured tag: %w", err)
		}
	}

	hasFeatured, err := columnExists(ctx, db, "collections", "featured")
	if err != nil {
		return err
	}
	if hasFeatured {
		if _, err := db.ExecContext(ctx,
			`INSERT OR IGNORE INTO collection_tags (collection_id, collection_language, tag_id)
			 SELECT id, language, 'tag_featured' FROM collections WHERE featured = 1`); err != nil {
			return fmt.Errorf("backfill featured tag: %w", err)
		}
		if _, err := db.ExecContext(ctx, `ALTER TABLE collections DROP COLUMN featured`); err != nil {
			return fmt.Errorf("drop featured column: %w", err)
		}
	}
	return nil
}

func columnExists(ctx context.Context, db *sql.DB, table, col string) (bool, error) {
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid, notnull, pk int
			name, ctype      string
			dflt             sql.NullString
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, rows.Err()
}

// backfillCombinedFtsRows ensures every track has a `kind='combined'`
// row in tracks_search. Idempotent: skips when at least one combined row
// already exists, otherwise wipes existing rows and rebuilds from
// tracks / track_variants / track_references / sources. Cheap to run on
// open — the no-op path is one SELECT.
func backfillCombinedFtsRows(ctx context.Context, db *sql.DB) error {
	var combinedCount int
	row := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM tracks_search WHERE kind = 'combined'`)
	if err := row.Scan(&combinedCount); err != nil {
		return fmt.Errorf("count combined rows: %w", err)
	}
	if combinedCount > 0 {
		return nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	idRows, err := tx.QueryContext(ctx, `SELECT id FROM tracks`)
	if err != nil {
		return fmt.Errorf("list tracks: %w", err)
	}
	var trackIDs []string
	for idRows.Next() {
		var id string
		if err := idRows.Scan(&id); err != nil {
			idRows.Close()
			return fmt.Errorf("scan track id: %w", err)
		}
		trackIDs = append(trackIDs, id)
	}
	idRows.Close()

	for _, id := range trackIDs {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM tracks_search WHERE track_id = ?`, id); err != nil {
			return fmt.Errorf("delete fts for %s: %w", id, err)
		}
		if err := rebuildTrackSearchRows(ctx, tx, id); err != nil {
			return fmt.Errorf("rebuild fts for %s: %w", id, err)
		}
	}
	return tx.Commit()
}

// SeededKindTags is the canonical, fixed set of recording-type tags. The
// extractmeta usecase (canonical parser + LLM) emits one of these slugs as
// `kind_tag`; commit resolves it to the matching tag_id.
var SeededKindTags = []struct {
	ID     string
	NameRu string
	NameEn string
}{
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

func seedKindTags(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, t := range SeededKindTags {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO tags (id, language, full_name) VALUES (?, ?, ?)`,
			t.ID, "ru", t.NameRu); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO tags (id, language, full_name) VALUES (?, ?, ?)`,
			t.ID, "en", t.NameEn); err != nil {
			return err
		}
	}
	return tx.Commit()
}
