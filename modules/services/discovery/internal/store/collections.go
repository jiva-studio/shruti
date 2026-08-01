package store

import (
	"context"
	"strconv"
	"time"
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
		INSERT INTO discovery.collections (source_id, url, title, description, author)
		VALUES (nullif($1,''), nullif($2,''), $3, nullif($4,''), nullif($5,''))
		ON CONFLICT `+conflict+` DO UPDATE SET
			title       = EXCLUDED.title,
			description = coalesce(EXCLUDED.description, discovery.collections.description),
			author      = coalesce(EXCLUDED.author, discovery.collections.author)
		RETURNING id`,
		c.SourceID, c.URL, c.Title, c.Description, c.Author,
	).Scan(&c.ID)
}

// CollectionByURL finds the cycle a page presents.
func (r *Repo) CollectionByURL(ctx context.Context, sourceID, url string) (*Collection, error) {
	var c Collection
	err := r.pool.QueryRow(ctx, `
		SELECT c.id, coalesce(c.source_id,''), coalesce(c.url,''), c.title,
		       coalesce(c.description,''), coalesce(c.author,''), `+memberCount+`
		FROM discovery.collections c
		WHERE c.source_id IS NOT DISTINCT FROM nullif($1,'') AND c.url = $2`,
		sourceID, url,
	).Scan(&c.ID, &c.SourceID, &c.URL, &c.Title, &c.Description, &c.Author, &c.MemberCount)
	if err != nil {
		return nil, nil
	}
	return &c, nil
}

// CollectionByTitle finds a cycle reconstructed from what its parts call it.
//
// The speaker is part of the identity: two lecturers can give courses of the
// same name, and the name alone would fold them into one. It is the speaker's
// key that decides, not the spelling — otherwise the same course filed under
// "Shyamananda Prabhu" and under "HG Shyamananda Das" becomes two.
func (r *Repo) CollectionByTitle(ctx context.Context, sourceID, title, author string) (*Collection, error) {
	var c Collection
	err := r.pool.QueryRow(ctx, `
		SELECT c.id, coalesce(c.source_id,''), coalesce(c.url,''), c.title,
		       coalesce(c.description,''), coalesce(c.author,''), `+memberCount+`
		FROM discovery.collections c
		WHERE c.source_id IS NOT DISTINCT FROM nullif($1,'')
		  AND c.title = $2
		  AND coalesce(c.author_key,'') = coalesce(discovery.author_key(nullif($3,'')),'')
		  AND c.url IS NULL`,
		sourceID, title, author,
	).Scan(&c.ID, &c.SourceID, &c.URL, &c.Title, &c.Description, &c.Author, &c.MemberCount)
	if err != nil {
		return nil, nil
	}
	return &c, nil
}

// ReplaceMembers records the parts a series page listed, in its order.
//
// They are stored as page addresses because the parts may not have been
// indexed yet; item_id is filled in whenever they are.
func (r *Repo) ReplaceMembers(ctx context.Context, collectionID int64, pageURLs []string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		`DELETE FROM discovery.collection_members WHERE collection_id = $1`, collectionID); err != nil {
		return err
	}
	for i, u := range pageURLs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.collection_members (collection_id, ordinal, page_url, item_id)
			VALUES ($1, $2, $3, (SELECT i.id FROM discovery.items i
			                     JOIN discovery.pages p ON p.id = i.page_id
			                     WHERE p.url = $3 ORDER BY i.id LIMIT 1))`,
			collectionID, i, u); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
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

// ResolvePendingMembers fills in the recordings for a page whose series was
// indexed before it was. This is the half of the join that cannot happen at
// read time, because whichever side arrives first has to wait for the other.
func (r *Repo) ResolvePendingMembers(ctx context.Context, pageURL string, itemID int64) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE discovery.collection_members
		SET item_id = $2
		WHERE page_url = $1 AND item_id IS NULL`, pageURL, itemID)
	return err
}

// AbsorbByTitle folds a cycle reconstructed from its parts' own words into the
// one a series page defines.
//
// Both are the same cycle: the parts named it before we had read the page that
// presents it. The page is the better record — it has the order and the full
// membership — so it takes over, keeping any part the page did not list rather
// than dropping it.
//
// Name and speaker must both match. On one archive the only near-collision in
// forty-three cycles was "Секреты гармонии" against "Секреты гармонии в семье"
// — two courses by two different lecturers, which merging on the name alone
// would have destroyed.
func (r *Repo) AbsorbByTitle(ctx context.Context, into int64, sourceID, title, author string) error {
	// Without a speaker on both sides there is nothing to tell two courses of
	// the same name apart, and folding them would be a guess.
	if author == "" {
		return nil
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var from int64
	err = tx.QueryRow(ctx, `
		SELECT id FROM discovery.collections
		WHERE source_id IS NOT DISTINCT FROM nullif($1,'')
		  AND title = $2
		  AND author_key IS NOT DISTINCT FROM discovery.author_key(nullif($3,''))
		  AND url IS NULL`,
		sourceID, title, author).Scan(&from)
	if err != nil {
		return nil
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO discovery.collection_members (collection_id, ordinal, page_url, item_id)
		SELECT $1,
		       (SELECT coalesce(max(ordinal), -1) FROM discovery.collection_members WHERE collection_id = $1)
		           + row_number() OVER (ORDER BY m.ordinal),
		       m.page_url, m.item_id
		FROM discovery.collection_members m
		WHERE m.collection_id = $2
		  AND m.item_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM discovery.collection_members k
		                  WHERE k.collection_id = $1 AND k.item_id = m.item_id)`,
		into, from); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM discovery.collections WHERE id = $1`, from); err != nil {
		return err
	}
	return tx.Commit(ctx)
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

// minMembers is the fewest parts a cycle can be shown with. A course of one
// lecture is not a course.
//
// It bites on the cycles reconstructed from what the parts called themselves,
// where the name is often an occasion rather than a series: "Sunday Feast" and
// "Gaura Purnima Festival" are what happened that day, not a set of talks given
// together, and the archive holds hundreds of them under one speaker each. A
// page that presents a cycle is taken at its word — it says what it is, and may
// legitimately list one part so far.
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

// ReplacePageLinks stores what a page pointed at, for every page. It is what a
// cycle is decided from later, and what the crawl walks through when a page is
// not due to be fetched again.
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
		if _, err := tx.Exec(ctx,
			`INSERT INTO discovery.page_links (page_id, ordinal, url) VALUES ($1,$2,$3)`,
			pageID, i, u); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UnvisitedLinks are the addresses this source's pages point at that have
// never become pages themselves.
//
// This is the edge of the crawl, and it has to be a query rather than a walk.
// The queue is fed by fetching pages, but a page whose recheck has not come
// around is not fetched — so once a first sweep settles, every route onwards
// is behind a page nobody will open, and the crawl finds nothing for ever
// while most of the archive is still unseen. What those pages pointed at is
// already recorded; asking the table is the whole of the fix.
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

// KnownMediaLinks counts how many of these addresses are pages we have already
// found a recording on.
//
// This is the whole gate on the cycle question: a cycle is made of recordings,
// so a page that reaches none cannot be one, and asking would be spending a
// model call to be told that a menu is a menu.
func (r *Repo) KnownMediaLinks(ctx context.Context, urls []string) (int, error) {
	if len(urls) == 0 {
		return 0, nil
	}
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(DISTINCT p.id)
		FROM discovery.pages p
		WHERE p.url = ANY($1) AND p.media_found > 0`, urls).Scan(&n)
	return n, err
}

// SetSeriesLinksSeen remembers what the cycle question was asked about.
func (r *Repo) SetSeriesLinksSeen(ctx context.Context, pageID int64, n int) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE discovery.pages SET series_links_seen = $2 WHERE id = $1`, pageID, n)
	return err
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
