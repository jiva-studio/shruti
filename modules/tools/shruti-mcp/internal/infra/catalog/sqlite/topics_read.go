package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// ListTopicCovers returns every distinct topic id with whether it already has a
// cover image. One row per topic (cover is stored on all locales, so collapse on
// id). Ordered by id for deterministic batch progress.
func (r *Repo) ListTopicCovers(ctx context.Context) ([]catalog.TopicCover, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, MAX(CASE WHEN cover IS NOT NULL AND cover != '' THEN 1 ELSE 0 END)
		   FROM topics GROUP BY id ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catalog.TopicCover
	for rows.Next() {
		var tc catalog.TopicCover
		var has int
		if err := rows.Scan(&tc.ID, &has); err != nil {
			return nil, err
		}
		tc.HasCover = has == 1
		out = append(out, tc)
	}
	return out, rows.Err()
}

// GetTopicName returns a topic's full name in the requested language, falling
// back to en and then any available locale. ok=false when the topic is absent.
func (r *Repo) GetTopicName(ctx context.Context, id, language string) (string, bool, error) {
	for _, l := range []string{language, "en"} {
		if l == "" {
			continue
		}
		var name string
		err := r.db.QueryRowContext(ctx,
			`SELECT full_name FROM topics WHERE id = ? AND language = ?`, id, l).Scan(&name)
		if err == nil {
			return name, true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", false, err
		}
	}
	var name string
	err := r.db.QueryRowContext(ctx,
		`SELECT full_name FROM topics WHERE id = ? LIMIT 1`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return name, true, nil
}
