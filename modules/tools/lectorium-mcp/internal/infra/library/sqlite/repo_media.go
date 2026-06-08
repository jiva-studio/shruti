package sqlitelibrary

import (
	"context"
	"fmt"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

// ---------- MEDIA ----------

// MediaUpsert writes one library_media row, replacing any existing row with
// the same id (INSERT OR REPLACE). meta is the already-serialized JSON string
// (empty → stored as NULL). Idempotent: re-running an import with the same id
// overwrites in place, so the importer is safe to retry.
func (r *Repo) MediaUpsert(ctx context.Context, m library.Media) error {
	if m.ID == "" || m.Lang == "" || m.Title == "" || m.URL == "" || m.Type == "" {
		return fmt.Errorf("media upsert: id, lang, title, url, type required")
	}
	var meta any
	if m.Meta != "" {
		meta = m.Meta
	}
	var context, embed any
	if m.Context != "" {
		context = m.Context
	}
	if m.EmbedText != "" {
		embed = m.EmbedText
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO library_media
			(id, lang, title, text, context, embed_text, url, type, meta)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		m.ID, m.Lang, m.Title, m.Text, context, embed, m.URL, m.Type, meta,
	); err != nil {
		return fmt.Errorf("upsert media: %w", err)
	}
	return nil
}
