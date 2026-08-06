package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Author is one speaker: a name of our own, and every spelling the archive
// filed them under.
type Author struct {
	ID       int64    `json:"id"`
	Name     string   `json:"name"`
	Keys     []string `json:"keys,omitempty"`
	Variants []string `json:"variants,omitempty"`
	Items    int      `json:"items"`
}

// ResolveAuthor finds the person a written name belongs to, creating them the
// first time any spelling of it is seen. A spelling seen before resolves to
// whoever it resolved to last time.
func (r *Repo) ResolveAuthor(ctx context.Context, name string) (int64, error) {
	if name == "" {
		return 0, nil
	}
	key := domain.Key(name)
	if key == "" {
		return 0, nil
	}
	var id int64
	err := r.pool.QueryRow(ctx, `
		WITH found AS (
			SELECT a.author_id FROM discovery.author_keys a WHERE a.key = $2
		),
		made AS (
			INSERT INTO discovery.authors (name)
			SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM found)
			RETURNING id
		),
		linked AS (
			INSERT INTO discovery.author_keys (key, author_id)
			SELECT $2, made.id FROM made
			ON CONFLICT (key) DO NOTHING
			RETURNING author_id
		)
		SELECT author_id FROM found
		UNION ALL SELECT author_id FROM linked
		LIMIT 1`, domain.Name(name), key).Scan(&id)
	// No row means nobody by that name, which is an answer. Anything else is the
	// database failing, and reporting that as "no author" files the recording
	// under nobody while the run reports success.
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return id, nil
}

// Authors lists speakers, most recorded first, with every spelling the archive
// filed them under.
func (r *Repo) Authors(ctx context.Context, sourceID string, limit int) ([]Author, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT a.id, a.name,
		       coalesce(array_agg(DISTINCT k.key) FILTER (WHERE k.key IS NOT NULL), '{}'),
		       coalesce(array_agg(DISTINCT i.author) FILTER (WHERE i.author IS NOT NULL), '{}'),
		       count(i.id)::int
		FROM discovery.authors a
		LEFT JOIN discovery.author_keys k ON k.author_id = a.id
		LEFT JOIN discovery.item_authors ia ON ia.author_id = a.id
		LEFT JOIN discovery.items i ON i.id = ia.item_id AND ($1 = '' OR i.source_id = $1)
		GROUP BY a.id, a.name
		HAVING count(i.id) > 0
		ORDER BY count(i.id) DESC, a.name
		LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Author
	for rows.Next() {
		var a Author
		if err := rows.Scan(&a.ID, &a.Name, &a.Keys, &a.Variants, &a.Items); err != nil {
			return nil, err
		}
		if len(a.Variants) < 2 {
			a.Variants = nil
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SetItemAuthors replaces the people a recording is by. A set, not a list:
// which speaker was named first carries no meaning worth storing.
func (r *Repo) SetItemAuthors(ctx context.Context, itemID int64, authorIDs []int64) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM discovery.item_authors WHERE item_id = $1 AND NOT (author_id = ANY($2))`,
		itemID, authorIDs); err != nil {
		return err
	}
	for _, id := range authorIDs {
		if _, err := tx.Exec(ctx,
			`INSERT INTO discovery.item_authors (item_id, author_id) VALUES ($1,$2)
			 ON CONFLICT DO NOTHING`, itemID, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
