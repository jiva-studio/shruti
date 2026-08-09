package store

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

// Collection is a cycle of recordings: a course, a seminar, a set of talks
// given together.
//
// Its identity is the URL of the page that presents it, when there is one.
// Where an archive names the cycle on each part and has no page for it, the
// title within the source has to serve instead.
type Collection struct {
	ID          int64  `json:"id"`
	SourceID    string `json:"source,omitempty"`
	URL         string `json:"url,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Author      string `json:"author,omitempty"`
	// MemberCount is counted from the membership rows when asked. It is not
	// stored: a number kept alongside the rows it counts is a number that will
	// disagree with them.
	MemberCount int `json:"member_count"`
}

// memberCount counts a cycle's parts inside a query.
const memberCount = `(SELECT count(*) FROM discovery.collection_members m WHERE m.collection_id = c.id)`

// SaveCollection writes the cycle and returns its id.
func (r *Repo) SaveCollection(ctx context.Context, c *Collection) error {
	// Two identities, two conflict targets: a series with a page of its own is
	// keyed by that page, and one reconstructed from what its parts call it is
	// keyed by the name they used.
	conflict := "(source_id, title, coalesce(author_key, '')) WHERE url IS NULL"
	if c.URL != "" {
		conflict = "(source_id, url) WHERE url IS NOT NULL"
	}
	return r.pool.QueryRow(ctx, `
		INSERT INTO discovery.collections (source_id, url, title, description, author, author_key)
		VALUES (nullif($1,''), nullif($2,''), $3, nullif($4,''), nullif($5,''), nullif($6,''))
		ON CONFLICT `+conflict+` DO UPDATE SET
			title       = EXCLUDED.title,
			description = coalesce(EXCLUDED.description, discovery.collections.description),
			author      = coalesce(EXCLUDED.author, discovery.collections.author),
			author_key  = coalesce(EXCLUDED.author_key, discovery.collections.author_key)
		RETURNING id`,
		c.SourceID, c.URL, c.Title, c.Description, c.Author, domain.Key(c.Author),
	).Scan(&c.ID)
}

// CollectionByTitle finds a cycle reconstructed from what its parts call it.
// The speaker is part of the identity, by key rather than by spelling: two
// lecturers can give courses of the same name.
func (r *Repo) CollectionByTitle(ctx context.Context, sourceID, title, author string) (*Collection, error) {
	var c Collection
	err := r.pool.QueryRow(ctx, `
		SELECT c.id, coalesce(c.source_id,''), coalesce(c.url,''), c.title,
		       coalesce(c.description,''), coalesce(c.author,''), `+memberCount+`
		FROM discovery.collections c
		WHERE c.source_id IS NOT DISTINCT FROM nullif($1,'')
		  AND c.title = $2
		  AND coalesce(c.author_key,'') = $3
		  AND c.url IS NULL`,
		sourceID, title, domain.Key(author),
	).Scan(&c.ID, &c.SourceID, &c.URL, &c.Title, &c.Description, &c.Author, &c.MemberCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// AddMember attaches one recording to a cycle at the end, used when the part
// names its series and no page lists the membership.
func (r *Repo) AddMember(ctx context.Context, collectionID, itemID int64) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO discovery.collection_members (collection_id, ordinal, page_url, item_id)
		SELECT $1, coalesce(max(ordinal) + 1, 0), '', $2
		FROM discovery.collection_members WHERE collection_id = $1
		ON CONFLICT DO NOTHING`, collectionID, itemID)
	return err
}

// ItemHasCollection reports whether a recording already belongs to a cycle.
//
// A series page places its parts exactly, by address and in order. The name a
// part gives the cycle is the weaker handle and must not create a second
// collection alongside the one that already holds it.
func (r *Repo) ItemHasCollection(ctx context.Context, itemID int64) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM discovery.collection_members WHERE item_id = $1)`,
		itemID).Scan(&exists)
	return exists, err
}

// CollectionView is a cycle with its parts filled in.
type CollectionView struct {
	Collection
	Members []CollectionMember `json:"members"`
	// Pending is how many parts the series listed that we have not indexed
	// yet. A non-zero count is a to-do, not a fault.
	Pending int `json:"pending,omitempty"`
}

type CollectionMember struct {
	Ordinal    int        `json:"ordinal"`
	ItemID     *int64     `json:"item_id,omitempty"`
	PageURL    string     `json:"page_url,omitempty"`
	Title      string     `json:"title,omitempty"`
	MediaURL   string     `json:"media_url,omitempty"`
	RecordedOn *time.Time `json:"recorded_on,omitempty"`
}

// minMembers is the fewest parts a cycle reconstructed from its parts' own
// words can be shown with: a course of one lecture is not a course. A page that
// presents a cycle is taken at its word and may list one part so far.
const minMembers = 2

// Collections lists what we know of a source's cycles.
func (r *Repo) Collections(ctx context.Context, sourceID string, limit int) ([]CollectionView, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT c.id, coalesce(c.source_id,''), coalesce(c.url,''), c.title,
		       coalesce(c.description,''), coalesce(c.author,''), `+memberCount+`
		FROM discovery.collections c
		WHERE ($1 = '' OR c.source_id = $1)
		  AND (c.url IS NOT NULL OR `+memberCount+` >= `+strconv.Itoa(minMembers)+`)
		ORDER BY c.title LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	var out []CollectionView
	for rows.Next() {
		var v CollectionView
		if err := rows.Scan(&v.ID, &v.SourceID, &v.URL, &v.Title,
			&v.Description, &v.Author, &v.MemberCount); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for i := range out {
		if out[i].Members, out[i].Pending, err = r.members(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *Repo) members(ctx context.Context, collectionID int64) ([]CollectionMember, int, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT m.ordinal, m.item_id, m.page_url,
		       coalesce(i.title,''), coalesce(i.media_url,''), i.recorded_on
		FROM discovery.collection_members m
		LEFT JOIN discovery.items i ON i.id = m.item_id
		WHERE m.collection_id = $1
		ORDER BY m.ordinal`, collectionID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var members []CollectionMember
	pending := 0
	for rows.Next() {
		var m CollectionMember
		if err := rows.Scan(&m.Ordinal, &m.ItemID, &m.PageURL,
			&m.Title, &m.MediaURL, &m.RecordedOn); err != nil {
			return nil, 0, err
		}
		if m.ItemID == nil {
			pending++
		}
		members = append(members, m)
	}
	return members, pending, rows.Err()
}

// ReplacePageLinks stores what a page pointed at, for every page.
func (r *Repo) ReplacePageLinks(ctx context.Context, pageID int64, urls []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM discovery.page_links WHERE page_id = $1`, pageID); err != nil {
		return err
	}
	for i, u := range urls {
		// Idempotent on purpose. Two workers can be given the same page — a
		// manual run over a source the scheduler is also draining — and without
		// this the second one fails on the primary key after the first has
		// already deleted and reinserted the same rows.
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.page_links (page_id, ordinal, url, url_key) VALUES ($1,$2,$3,$4)
			ON CONFLICT (page_id, ordinal) DO UPDATE SET url = EXCLUDED.url, url_key = EXCLUDED.url_key`,
			pageID, i, u, domain.URLKey(u)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UnvisitedLinks are the addresses this source's pages point at that have never
// become pages themselves — the edge of the crawl.
func (r *Repo) UnvisitedLinks(ctx context.Context, sourceID string, limit int) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT l.url
		FROM discovery.page_links l
		JOIN discovery.pages p ON p.id = l.page_id
		WHERE ($1 = '' OR p.source_id = $1)
		  AND NOT EXISTS (SELECT 1 FROM discovery.pages t WHERE t.url_key = l.url_key)
		LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// PageLinks reads back what a page pointed at, for a visit that had no body to
// re-read — a page unchanged since last time still has to be able to become a
// cycle once its parts exist.
func (r *Repo) PageLinks(ctx context.Context, pageID int64) ([]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT url FROM discovery.page_links WHERE page_id = $1 ORDER BY ordinal`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
