package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repo is the service's data access. Raw SQL, $N placeholders, everything
// qualified with the discovery schema.
type Repo struct {
	pool *pgxpool.Pool
}

func NewRepo(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Page is one URL we have fetched, with the validators that make the next
// visit cheap and the schedule that decides when it happens.
type Page struct {
	ID                   int64
	SourceID             *string
	URL                  string
	ETag                 string
	LastModified         string
	BodySHA256           string
	ItemSetSHA256        string
	HTTPStatus           int
	Error                string
	LastFetchedAt        *time.Time
	LastChangedAt        *time.Time
	ConsecutiveUnchanged int
	NextCheckAt          *time.Time
	// MediaFound is how many media addresses this page offered. Zero is a fact
	// worth keeping: it is how you find the pages we visited and came away from
	// empty-handed.
	MediaFound int
	// SeriesLinksSeen is how many of this page's links reached a recording we
	// had, the last time we asked whether it presents a cycle. It keeps the
	// question from being re-asked when nothing has changed.
	SeriesLinksSeen int
	// NormPromptVersion is the prompt this page's files were last read with.
	// A newer prompt means the stored answers are stale even when the page is
	// byte-identical.
	NormPromptVersion string
}

const pageCols = `id, source_id, url, coalesce(etag,''), coalesce(last_modified,''),
	coalesce(body_sha256,''), coalesce(item_set_sha256,''), coalesce(http_status,0),
	coalesce(error,''), last_fetched_at, last_changed_at, consecutive_unchanged, next_check_at,
	coalesce(norm_prompt_version,''), media_found, series_links_seen`

func scanPage(row pgx.Row) (*Page, error) {
	var p Page
	err := row.Scan(&p.ID, &p.SourceID, &p.URL, &p.ETag, &p.LastModified,
		&p.BodySHA256, &p.ItemSetSHA256, &p.HTTPStatus, &p.Error,
		&p.LastFetchedAt, &p.LastChangedAt, &p.ConsecutiveUnchanged, &p.NextCheckAt,
		&p.NormPromptVersion, &p.MediaFound, &p.SeriesLinksSeen)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// PageByURL returns the stored page, or nil when we have never fetched it.
func (r *Repo) PageByURL(ctx context.Context, url string) (*Page, error) {
	return scanPage(r.pool.QueryRow(ctx, `SELECT `+pageCols+` FROM discovery.pages WHERE url = $1`, url))
}

// PageByID reads a page we already have the id of.
func (r *Repo) PageByID(ctx context.Context, id int64) (*Page, error) {
	return scanPage(r.pool.QueryRow(ctx, `SELECT `+pageCols+` FROM discovery.pages WHERE id = $1`, id))
}

// SavePage writes the page and returns its id. The URL is the natural key, so
// re-fetching a page updates the row rather than growing the table.
func (r *Repo) SavePage(ctx context.Context, p *Page) (int64, error) {
	var id int64
	err := r.pool.QueryRow(ctx, `
		INSERT INTO discovery.pages
			(source_id, url, etag, last_modified, body_sha256, item_set_sha256,
			 http_status, error, last_fetched_at, last_changed_at,
			 consecutive_unchanged, next_check_at, norm_prompt_version, media_found)
		VALUES ($1,$2,nullif($3,''),nullif($4,''),nullif($5,''),nullif($6,''),
			 $7,nullif($8,''),$9,$10,$11,$12,nullif($13,''),$14)
		ON CONFLICT (url) DO UPDATE SET
			source_id             = coalesce(EXCLUDED.source_id, discovery.pages.source_id),
			etag                  = EXCLUDED.etag,
			last_modified         = EXCLUDED.last_modified,
			body_sha256           = coalesce(EXCLUDED.body_sha256, discovery.pages.body_sha256),
			item_set_sha256       = coalesce(EXCLUDED.item_set_sha256, discovery.pages.item_set_sha256),
			http_status           = EXCLUDED.http_status,
			error                 = EXCLUDED.error,
			last_fetched_at       = EXCLUDED.last_fetched_at,
			last_changed_at       = coalesce(EXCLUDED.last_changed_at, discovery.pages.last_changed_at),
			consecutive_unchanged = EXCLUDED.consecutive_unchanged,
			next_check_at         = EXCLUDED.next_check_at,
			norm_prompt_version   = coalesce(EXCLUDED.norm_prompt_version, discovery.pages.norm_prompt_version),
			media_found           = EXCLUDED.media_found
		RETURNING id`,
		p.SourceID, p.URL, p.ETag, p.LastModified, p.BodySHA256, p.ItemSetSHA256,
		p.HTTPStatus, p.Error, p.LastFetchedAt, p.LastChangedAt,
		p.ConsecutiveUnchanged, p.NextCheckAt, p.NormPromptVersion, p.MediaFound,
	).Scan(&id)
	if err != nil {
		return 0, err
	}
	p.ID = id
	return id, nil
}

// DuePages returns pages whose next check has come around, oldest first.
func (r *Repo) DuePages(ctx context.Context, sourceID string, now time.Time, limit int) ([]Page, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+pageCols+`
		FROM discovery.pages
		WHERE ($1 = '' OR source_id = $1)
		  AND next_check_at IS NOT NULL AND next_check_at <= $2
		ORDER BY next_check_at
		LIMIT $3`, sourceID, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Page
	for rows.Next() {
		p, err := scanPage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// QueueDepth counts pages waiting for a recheck.
func (r *Repo) QueueDepth(ctx context.Context, now time.Time) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM discovery.pages
		WHERE next_check_at IS NOT NULL AND next_check_at <= $1`, now).Scan(&n)
	return n, err
}

// PageStats counts what a source's crawl has come to. Both numbers are read
// off the pages table — the empty count is what the partial index on
// media_found is for — so nothing is tallied anywhere and nothing can drift
// out of step with the rows it describes.
func (r *Repo) PageStats(ctx context.Context, sourceID string) (visited, empty int, err error) {
	err = r.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE media_found = 0)
		FROM discovery.pages
		WHERE ($1 = '' OR source_id = $1)`, sourceID).Scan(&visited, &empty)
	return visited, empty, err
}

// EmptyPages lists the pages we visited and found no file on — the trail left
// when a page is a menu, or a lecture whose audio we could not see.
func (r *Repo) EmptyPages(ctx context.Context, sourceID string, limit int) ([]Page, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+pageCols+`
		FROM discovery.pages
		WHERE media_found = 0 AND ($1 = '' OR source_id = $1)
		ORDER BY last_fetched_at DESC NULLS LAST
		LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Page
	for rows.Next() {
		p, err := scanPage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// ShapeYield is what pages of one URL shape have turned out to be worth.
type ShapeYield struct {
	Pages int
	Media int
}

// ShapeYields reports, per URL shape, how many pages of that shape have been
// visited and how many media files they held.
//
// It is counted from the pages table when asked. The shape is the address with
// its digits blanked, which is what separates the productive part of a site
// from its scaffolding without anyone describing either: on one archive
// /audios/N yielded a file every time and /authors/N never did.
func (r *Repo) ShapeYields(ctx context.Context, sourceID string) (map[string]ShapeYield, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT regexp_replace(regexp_replace(url, '^https?://[^/]+', ''), '[0-9]+', '#', 'g') AS shape,
		       count(*), coalesce(sum(media_found), 0)
		FROM discovery.pages
		WHERE ($1 = '' OR source_id = $1)
		GROUP BY 1`, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]ShapeYield{}
	for rows.Next() {
		var shape string
		var y ShapeYield
		if err := rows.Scan(&shape, &y.Pages, &y.Media); err != nil {
			return nil, err
		}
		out[shape] = y
	}
	return out, rows.Err()
}
