package sqlitelibrary

import (
	"context"
	"database/sql"
	"fmt"
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
			kind        TEXT NOT NULL CHECK (kind IN ('question', 'topic')),
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

		`CREATE TABLE IF NOT EXISTS library_attribution_refs (
			attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
			ref_kind       TEXT NOT NULL CHECK (ref_kind IN ('verse', 'document')),
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

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}
