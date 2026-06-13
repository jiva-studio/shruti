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
	if err := seedKindTags(ctx, db); err != nil {
		return fmt.Errorf("seed kind tags: %w", err)
	}
	if err := backfillCombinedFtsRows(ctx, db); err != nil {
		return fmt.Errorf("backfill combined fts: %w", err)
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

// createCollectionTables builds the schema from scratch. In production the
// catalog always ships with the tables already present (legacy `packs` or the
// renamed `collections`), so this path is only exercised by fresh test DBs.
func createCollectionTables(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS collections (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			featured    INTEGER NOT NULL DEFAULT 0,
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
