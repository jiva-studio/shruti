package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
)

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
