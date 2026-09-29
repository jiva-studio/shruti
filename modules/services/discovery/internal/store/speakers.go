package store

import (
	"context"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// ResolveAuthors turns a written name into the people it could mean, running
// over the authors rather than over the recordings so that a filter on them
// can stay an indexed equality.
//
// A name that names somebody exactly means that person and nobody else.
// Widening to everyone whose name merely starts the same way would answer
// "Radhanath Swami" with a dozen people, most of them joint recordings he
// happens to appear in. Only a name that matches nobody falls back to a loose
// match, which is what makes a partial name work.
func (s *SearchIndex) ResolveAuthors(ctx context.Context, name string) ([]int64, error) {
	// The key is the settled spelling of a name; the folded key is that spelling
	// past its alphabet, so "Vatsala das" finds "Ватсала дас" and "Adi
	// Gadadhara" finds "Adi Gadadhar".
	//
	// Exact and folded are taken together, not one before the other. Tried in
	// order, the exact tier would win and stop — and "Srila Prabhupada" would
	// land on a Latin row of 10 recordings while the Cyrillic row of 1,526 sat
	// behind the fold, unreachable. One person spelled two ways is what the fold is for;
	// preferring either spelling defeats it.
	//
	// A fold can land on two people — it drops what a form of address carries,
	// and "Govinda Swami" and "Govinda das" are not one man — so it is a way to
	// look somebody up and never a claim about who they are. Both come back,
	// which is what a filter asked by name should do. The loose tier stays last
	// and fires only when neither found anybody.
	rows, err := s.pool.Query(ctx, `
		WITH exact AS (
			SELECT k.author_id AS id FROM discovery.author_keys k WHERE k.key = $2
		),
		folded AS (
			SELECT k.author_id AS id FROM discovery.author_keys k
			WHERE $3 <> '' AND k.key_folded = $3
		)
		SELECT id FROM exact
		UNION
		SELECT id FROM folded
		UNION
		SELECT a.id
		FROM discovery.authors a
		LEFT JOIN discovery.author_keys k ON k.author_id = a.id
		WHERE NOT EXISTS (SELECT 1 FROM exact)
		  AND NOT EXISTS (SELECT 1 FROM folded)
		  AND (k.key LIKE $2 || '%' OR a.name ILIKE '%' || $1 || '%')`,
		name, domain.Key(name), domain.Fold(domain.Key(name)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// SpeakersNamed finds who the corpus knows under any of these spellings,
// matched by folded key, with how many recordings are theirs and how many
// other recordings merely mention the spelling in a title.
func (s *SearchIndex) SpeakersNamed(ctx context.Context, spellings, folded []string) ([]domain.Speaker, error) {
	rows, err := s.pool.Query(ctx, `
		WITH want AS (SELECT * FROM unnest($1::text[], $2::text[]) AS t(spelling, fold)),
		found AS (
			SELECT w.spelling, a.id, a.name
			FROM want w
			JOIN discovery.author_keys k ON k.key_folded = w.fold
			JOIN discovery.authors a ON a.id = k.author_id
		)
		SELECT f.spelling, f.name,
			(SELECT count(*) FROM discovery.item_authors ia WHERE ia.author_id = f.id),
			(SELECT count(*) FROM discovery.items i
			 WHERE i.title ILIKE '%' || f.spelling || '%'
			   AND NOT EXISTS (SELECT 1 FROM discovery.item_authors ia
			                   WHERE ia.item_id = i.id AND ia.author_id = f.id))
		FROM found f`, spellings, folded)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Speaker
	for rows.Next() {
		var sp domain.Speaker
		if err := rows.Scan(&sp.Spelling, &sp.Name, &sp.Own, &sp.Other); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}
