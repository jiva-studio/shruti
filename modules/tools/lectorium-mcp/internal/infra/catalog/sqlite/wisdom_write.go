package sqlitecatalog

import (
	"context"
	"fmt"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/infra/sqliteutil"
)

// CreateDailyWisdom inserts one wisdom fragment row.
func (r *Repo) CreateDailyWisdom(ctx context.Context, w catalog.DailyWisdom) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx,
			`INSERT INTO daily_wisdom (id, track_id, language, start_ms, end_ms, text, topic_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			w.ID, w.TrackID, w.Language, w.StartMs, w.EndMs, w.Text, w.TopicID)
		return err
	})
}

// ListDailyWisdom returns wisdom rows, optionally filtered by topic and/or
// language (empty = no filter), newest first, capped at limit (0 = no cap).
func (r *Repo) ListDailyWisdom(ctx context.Context, topicID, language string, limit int) ([]catalog.DailyWisdom, error) {
	q := `SELECT id, track_id, language, start_ms, end_ms, text, topic_id, created_at FROM daily_wisdom`
	var args []any
	var conds []string
	if topicID != "" {
		conds = append(conds, "topic_id = ?")
		args = append(args, topicID)
	}
	if language != "" {
		conds = append(conds, "language = ?")
		args = append(args, language)
	}
	for i, c := range conds {
		if i == 0 {
			q += " WHERE " + c
		} else {
			q += " AND " + c
		}
	}
	q += " ORDER BY created_at DESC"
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list daily_wisdom: %w", err)
	}
	defer rows.Close()
	var out []catalog.DailyWisdom
	for rows.Next() {
		var w catalog.DailyWisdom
		if err := rows.Scan(&w.ID, &w.TrackID, &w.Language, &w.StartMs, &w.EndMs, &w.Text, &w.TopicID, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// DeleteDailyWisdom removes one wisdom row by id.
func (r *Repo) DeleteDailyWisdom(ctx context.Context, id string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx, `DELETE FROM daily_wisdom WHERE id = ?`, id)
		return err
	})
}
