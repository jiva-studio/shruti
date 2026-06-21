package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// GetSetting reads one settings row. ok=false when the key is absent.
func (r *Repo) GetSetting(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := r.db.QueryRowContext(ctx,
		`SELECT value FROM settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("get settings %q: %w", key, err)
	}
	return value, true, nil
}

// SetSetting upserts one settings row and refreshes updated_at.
func (r *Repo) SetSetting(ctx context.Context, key, value string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx,
			`INSERT INTO settings (key, value, updated_at)
			 VALUES (?, ?, CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER))
			 ON CONFLICT(key) DO UPDATE SET
			   value = excluded.value,
			   updated_at = excluded.updated_at`,
			key, value)
		return err
	})
}

// ListSettings returns all rows whose key starts with prefix (empty = all),
// ordered by key.
func (r *Repo) ListSettings(ctx context.Context, prefix string) ([]catalog.Setting, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT key, value, updated_at FROM settings WHERE key LIKE ? ORDER BY key`,
		prefix+"%")
	if err != nil {
		return nil, fmt.Errorf("list settings: %w", err)
	}
	defer rows.Close()
	var out []catalog.Setting
	for rows.Next() {
		var kv catalog.Setting
		if err := rows.Scan(&kv.Key, &kv.Value, &kv.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, kv)
	}
	return out, rows.Err()
}
