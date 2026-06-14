package sqlitecatalog

import (
	"context"
	"fmt"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// SetAuthorImage records the avatar S3 key on every locale row of an author.
// The avatar is language-neutral, so the same key is written to all locales.
// Returns an error if the author id is unknown (no rows updated).
func (r *Repo) SetAuthorImage(ctx context.Context, id, key string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		res, err := r.db.ExecContext(ctx, `UPDATE authors SET image = ? WHERE id = ?`, key, id)
		if err != nil {
			return fmt.Errorf("set author image: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("author/%s not found", id)
		}
		return nil
	})
}

// SetAuthorDescription writes a short bio onto one (author id, language) row.
func (r *Repo) SetAuthorDescription(ctx context.Context, id, language, description string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		res, err := r.db.ExecContext(ctx,
			`UPDATE authors SET description = ? WHERE id = ? AND language = ?`,
			description, id, language)
		if err != nil {
			return fmt.Errorf("set author description: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return fmt.Errorf("author/%s [%s] not found", id, language)
		}
		return nil
	})
}
