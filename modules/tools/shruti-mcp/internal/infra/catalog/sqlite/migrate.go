package sqlitecatalog

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// applyLocalMigrations runs schema tweaks against current.db on every
// catalog open. ALTER TABLE failures from "column already exists" / "no such
// column" are swallowed so subsequent runs are no-ops; anything else
// surfaces.
//
// Wire-schema state after this runs:
//
//   - track_variants has `sort_reference TEXT NOT NULL DEFAULT ''` (per-
//     locale by-reference sort key, leading prefix is the localized source
//     short_name)
//   - track_variants does NOT have the legacy `tag_id` column (tags live
//     in the canonical `track_tags` join table)
//   - 11 fixed kind-tag rows seeded so resolver/auto-create find them
func applyLocalMigrations(ctx context.Context, db *sql.DB) error {
	if err := seedKindTags(ctx, db); err != nil {
		return fmt.Errorf("seed kind tags: %w", err)
	}
	stmts := []string{
		`ALTER TABLE track_variants ADD COLUMN sort_reference TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE track_variants DROP COLUMN tag_id`,
		`CREATE INDEX IF NOT EXISTS idx_track_variants_sort_reference
		 ON track_variants(language, sort_reference)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			msg := err.Error()
			// SQLite errors when the change has already been applied:
			//   "duplicate column name"  — ALTER ADD COLUMN no-op
			//   "no such column"         — ALTER DROP COLUMN no-op
			if strings.Contains(msg, "duplicate column name") ||
				strings.Contains(msg, "no such column") {
				continue
			}
			return fmt.Errorf("local migration: %s: %w", s, err)
		}
	}
	if err := backfillCombinedFtsRows(ctx, db); err != nil {
		return fmt.Errorf("backfill combined fts: %w", err)
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

