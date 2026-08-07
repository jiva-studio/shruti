package store

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
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

// MergeAuthors makes two rows one person.
//
// The keys move rather than the recordings: every spelling that resolved to the
// absorbed person now resolves to the surviving one, so the next crawl finds
// them there and does not recreate what was just removed. That is the whole
// reason spellings live in a table of their own.
//
// Idempotent, and refuses to merge somebody into themselves.
func (r *Repo) MergeAuthors(ctx context.Context, keep, absorb int64) error {
	if keep == absorb {
		return fmt.Errorf("merge: %d into itself", keep)
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`UPDATE discovery.author_keys SET author_id = $1 WHERE author_id = $2`, keep, absorb); err != nil {
		return err
	}
	// A recording already linked to both would break the primary key, so the
	// ones that would collide are dropped rather than moved.
	if _, err := tx.Exec(ctx, `
		DELETE FROM discovery.item_authors a
		WHERE a.author_id = $2
		  AND EXISTS (SELECT 1 FROM discovery.item_authors b
		              WHERE b.item_id = a.item_id AND b.author_id = $1)`, keep, absorb); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE discovery.item_authors SET author_id = $1 WHERE author_id = $2`, keep, absorb); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM discovery.authors WHERE id = $1`, absorb); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Alike is pairs of people who may be one, by the sound of their names rather
// than their spelling.
//
// This is what domain.Fold is for, and until now nothing called it. It is
// deliberately coarser than the key: it proposes, and somebody decides. Two
// romanisations of one name meet here, and so do the two alphabets — a Russian
// archive writes Локанатха and an English one Lokanatha, and they are one man.
//
// Where it cannot see a match it says nothing. Russian renders the Sanskrit
// "jña" as "гья", so Сарвагья and Sarvajna stay apart, and joining them is a
// decision rather than a rule.
func (r *Repo) Alike(ctx context.Context, limit int) ([]Similar, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT a.id, a.name, count(ia.item_id)::int
		FROM discovery.authors a
		LEFT JOIN discovery.item_authors ia ON ia.author_id = a.id
		GROUP BY a.id, a.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type row struct {
		id    int64
		name  string
		items int
	}
	var all []row
	for rows.Next() {
		var x row
		if err := rows.Scan(&x.id, &x.name, &x.items); err != nil {
			return nil, err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Grouped in Go rather than in SQL: the folding is corpus knowledge and
	// lives in domain, and a thousand names is nothing to walk.
	byFold := map[string][]row{}
	for _, x := range all {
		f := domain.Fold(domain.Key(x.name))
		if f == "" {
			continue
		}
		byFold[f] = append(byFold[f], x)
	}

	var out []Similar
	for f, group := range byFold {
		if len(group) < 2 {
			continue
		}
		sort.Slice(group, func(i, j int) bool { return group[i].items > group[j].items })
		s := Similar{Fold: f}
		for _, x := range group {
			s.Authors = append(s.Authors, Author{ID: x.id, Name: x.name, Items: x.items})
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Fold < out[j].Fold })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Similar is a set of people who sound like one person.
type Similar struct {
	// Fold is what they all reduce to, which is the reason they are here.
	Fold    string   `json:"fold"`
	Authors []Author `json:"authors"`
}
