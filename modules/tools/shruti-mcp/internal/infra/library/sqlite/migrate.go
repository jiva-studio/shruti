package sqlitelibrary

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// applyLocalMigrations runs additive, idempotent DDL against library.db.
//
// Until now library.db schema lived only in agent/library_import/schema.sql,
// applied by the one-off import.py. That worked for read-only access. Once
// MCP write tools (library.attribution.*) need to mutate tables that may
// not exist on an older library.db (created before this feature shipped),
// we need a Go-side self-healing migration on Open().
//
// Schema additions here MUST stay additive (CREATE TABLE IF NOT EXISTS,
// CREATE INDEX IF NOT EXISTS) so the function is safe to re-run on every
// Open() — including against fresh imports that already have the tables.
//
// Mirrors the pattern in internal/infra/catalog/sqlite/migrate.go.
func applyLocalMigrations(ctx context.Context, db *sql.DB) error {
	if err := ensureAttributionTables(ctx, db); err != nil {
		return fmt.Errorf("ensure attribution tables: %w", err)
	}
	if err := relaxAttributionRefKindCheck(ctx, db); err != nil {
		return fmt.Errorf("relax attribution ref_kind check: %w", err)
	}
	if err := migrateAttributionKindToPinnedBoost(ctx, db); err != nil {
		return fmt.Errorf("migrate attribution kind to pinned/boost: %w", err)
	}
	return nil
}

// ensureAttributionTables creates the three library_attribution* tables
// used by the chat-service's code-driven research pipeline. Idempotent.
//
// Schema rationale:
//   - library_attributions: just (id, kind, timestamps). kind enum is
//     'question' | 'topic' — same shape, different consumer policy.
//   - library_attribution_texts: N text variants per (id, language). PK
//     includes text itself so multiple phrasings of one attribution can
//     coexist (e.g. "что такое разум" + "природа разума" both index).
//   - library_attribution_refs: opaque target_id pointing at either a
//     library_verses.id or library_documents.id depending on ref_kind.
//     Application layer validates existence on insert (cross-table FK
//     not enforceable in SQLite).
func ensureAttributionTables(ctx context.Context, db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS library_attributions (
			id          TEXT PRIMARY KEY,
			kind        TEXT NOT NULL CHECK (kind IN ('pinned', 'boost')),
			created_at  TIMESTAMP NOT NULL,
			updated_at  TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS library_attributions_by_kind
			ON library_attributions(kind)`,

		`CREATE TABLE IF NOT EXISTS library_attribution_texts (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			language       TEXT NOT NULL,
			text           TEXT NOT NULL,
			PRIMARY KEY (attribution_id, language, text)
		)`,

		// No CHECK on ref_kind: kinds (verse | document | title | …) are
		// validated in the repo layer, so new ref kinds never need a schema
		// migration. relaxAttributionRefKindCheck() rebuilds older DBs that
		// still carry the original CHECK constraint.
		`CREATE TABLE IF NOT EXISTS library_attribution_refs (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind       TEXT NOT NULL,
			target_id      TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (attribution_id, ref_kind, target_id)
		)`,
		`CREATE INDEX IF NOT EXISTS library_attr_refs_by_target
			ON library_attribution_refs(ref_kind, target_id)`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("apply %q: %w", firstLine(s), err)
		}
	}
	return nil
}

// relaxAttributionRefKindCheck rebuilds library_attribution_refs to drop the
// original `CHECK (ref_kind IN ('verse','document'))` so newer ref kinds (e.g.
// 'title') can be inserted. SQLite cannot drop a CHECK in place, so this does
// the standard create-copy-drop-rename rebuild. Idempotent: a no-op once the
// table no longer carries a CHECK (fresh DBs created above, or already-migrated
// ones). This is the last ref_kind migration — validation now lives in code.
func relaxAttributionRefKindCheck(ctx context.Context, db *sql.DB) error {
	var ddl string
	err := db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='table' AND name='library_attribution_refs'`,
	).Scan(&ddl)
	if err == sql.ErrNoRows {
		return nil // table not present yet (ensureAttributionTables makes it without a CHECK)
	}
	if err != nil {
		return err
	}
	if !strings.Contains(strings.ToUpper(ddl), "CHECK") {
		return nil // already relaxed
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []string{
		`CREATE TABLE library_attribution_refs_new (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind       TEXT NOT NULL,
			target_id      TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (attribution_id, ref_kind, target_id)
		)`,
		`INSERT INTO library_attribution_refs_new (attribution_id, ref_kind, target_id, position)
			SELECT attribution_id, ref_kind, target_id, position FROM library_attribution_refs`,
		`DROP TABLE library_attribution_refs`,
		`ALTER TABLE library_attribution_refs_new RENAME TO library_attribution_refs`,
		`CREATE INDEX IF NOT EXISTS library_attr_refs_by_target
			ON library_attribution_refs(ref_kind, target_id)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("rebuild %q: %w", firstLine(s), err)
		}
	}
	return tx.Commit()
}

// migrateAttributionKindToPinnedBoost renames the attribution kinds
// question→pinned and topic→boost, matching the search-industry pin/boost
// naming. The kind column carries a CHECK constraint, and SQLite can neither
// alter a CHECK in place nor UPDATE a row to a value the *old* CHECK forbids,
// so this is the standard create-copy-drop-rename rebuild with the value map
// applied during the copy. Idempotent: a no-op once the table's CHECK no
// longer mentions 'question' (fresh DBs, or already-migrated ones).
func migrateAttributionKindToPinnedBoost(ctx context.Context, db *sql.DB) error {
	var ddl string
	err := db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='table' AND name='library_attributions'`,
	).Scan(&ddl)
	if err == sql.ErrNoRows {
		return nil // table not present yet
	}
	if err != nil {
		return err
	}
	// ensureAttributionTables creates fresh DBs with the new CHECK already, so
	// the presence of the old value in the DDL is the migration trigger.
	if !strings.Contains(ddl, "'question'") {
		return nil // already migrated
	}

	// library_attributions is the FK parent of *_texts and *_refs with ON
	// DELETE CASCADE. The pool's connections run with _foreign_keys=ON, so a
	// naive DROP would cascade-delete every text and ref. PRAGMA foreign_keys
	// is per-connection AND a no-op inside a transaction, so pin the whole
	// rebuild to one dedicated connection: toggle FK OFF on it, rebuild in a
	// txn, restore FK, verify. The child rows reference id (unchanged), so
	// they stay valid across the parent swap.
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return fmt.Errorf("disable foreign_keys: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(ctx, `PRAGMA foreign_keys = ON`) }()

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmts := []string{
		`CREATE TABLE library_attributions_new (
			id          TEXT PRIMARY KEY,
			kind        TEXT NOT NULL CHECK (kind IN ('pinned', 'boost')),
			created_at  TIMESTAMP NOT NULL,
			updated_at  TIMESTAMP NOT NULL
		)`,
		`INSERT INTO library_attributions_new (id, kind, created_at, updated_at)
			SELECT id,
			       CASE kind WHEN 'question' THEN 'pinned'
			                 WHEN 'topic'    THEN 'boost'
			                 ELSE kind END,
			       created_at, updated_at
			FROM library_attributions`,
		`DROP TABLE library_attributions`,
		`ALTER TABLE library_attributions_new RENAME TO library_attributions`,
		`CREATE INDEX IF NOT EXISTS library_attributions_by_kind
			ON library_attributions(kind)`,
	}
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("rebuild %q: %w", firstLine(s), err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// Verify the FK graph is still intact after the parent swap.
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_key_check`); err != nil {
		return fmt.Errorf("foreign_key_check after rebuild: %w", err)
	}
	return nil
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}
