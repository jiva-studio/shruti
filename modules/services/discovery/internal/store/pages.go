package store

import (
	"context"

	"errors"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
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
	// ConsecutiveFailures backs off a page that keeps failing, the same way
	// ConsecutiveUnchanged backs off one that keeps not changing.
	ConsecutiveFailures int
	NextCheckAt         *time.Time
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
	coalesce(error,''), last_fetched_at, last_changed_at, consecutive_unchanged,
	consecutive_failures, next_check_at,
	coalesce(norm_prompt_version,''), media_found, series_links_seen`

func scanPage(row pgx.Row) (*Page, error) {
	var p Page
	err := row.Scan(&p.ID, &p.SourceID, &p.URL, &p.ETag, &p.LastModified,
		&p.BodySHA256, &p.ItemSetSHA256, &p.HTTPStatus, &p.Error,
		&p.LastFetchedAt, &p.LastChangedAt, &p.ConsecutiveUnchanged, &p.ConsecutiveFailures, &p.NextCheckAt,
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
			 consecutive_unchanged, consecutive_failures, next_check_at,
			 norm_prompt_version, media_found, url_key)
		VALUES ($1,$2,nullif($3,''),nullif($4,''),nullif($5,''),nullif($6,''),
			 $7,nullif($8,''),$9,$10,$11,$12,$13,nullif($14,''),$15,$16)
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
			consecutive_failures  = EXCLUDED.consecutive_failures,
			next_check_at         = EXCLUDED.next_check_at,
			norm_prompt_version   = coalesce(EXCLUDED.norm_prompt_version, discovery.pages.norm_prompt_version),
			media_found           = EXCLUDED.media_found
		RETURNING id`,
		p.SourceID, p.URL, p.ETag, p.LastModified, p.BodySHA256, p.ItemSetSHA256,
		p.HTTPStatus, p.Error, p.LastFetchedAt, p.LastChangedAt,
		p.ConsecutiveUnchanged, p.ConsecutiveFailures, p.NextCheckAt, p.NormPromptVersion, p.MediaFound,
		domain.URLKey(p.URL),
	).Scan(&id)
	if err != nil {
		return 0, err
	}
	p.ID = id
	return id, nil
}

// MarkPageIndexed records the proof that this page has been read in full: the
// hash of the body, the hash of the set of files on it, and the prompt those
// files were read under.
//
// It is a separate write from SavePage because it is the one the next visit
// believes. Everything else about a visit can be written as it happens; this
// may only be written once the recordings are safely stored, or a failure
// halfway through leaves a page claiming to be done that is never read again.
func (r *Repo) MarkPageIndexed(ctx context.Context, id int64, bodySHA, itemSet, promptVersion string) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE discovery.pages
		SET body_sha256 = nullif($2,''), item_set_sha256 = nullif($3,''),
		    norm_prompt_version = nullif($4,'')
		WHERE id = $1`, id, bodySHA, itemSet, promptVersion)
	return err
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
		SELECT (SELECT count(*) FROM discovery.pages
		        WHERE next_check_at IS NOT NULL AND next_check_at <= $1)
		     + (SELECT count(DISTINCT l.url_key) FROM discovery.page_links l
		        WHERE NOT EXISTS (SELECT 1 FROM discovery.pages t WHERE t.url_key = l.url_key))`,
		now).Scan(&n)
	return n, err
}

// Work is one address the scheduler should read, and which source asked for it.
type Work struct {
	URL      string
	SourceID string
}

// ClaimWork is work from every enabled source, taken a turn at a time.
//
// Three things are overdue and they are not the same. A source that has never
// been walked comes first, because until its seed is read it has no other work
// to offer. Then an address nobody has visited, which is new material — the
// reason a listing was re-read at all. Last a page whose time has come, and
// among those the one waiting longest goes first.
//
// That priority holds *within* a source. Between sources the claim goes round
// in turns, and it has to: ordered by urgency alone, whichever source is
// producing pages fastest wins every place in every claim, because its newest
// links keep arriving ahead of everybody else's. Measured on a live crawl — one
// archive in full backfill, a second added an hour later — the second source's
// two hundred and twenty-two links sat behind an ever-growing pile and a claim
// of two hundred came back two hundred to nil. It was not slow; it was never
// going to start.
//
// A turn nobody takes is not wasted: a source with five addresses contributes
// five and the rest of the claim goes to whoever else has work.
//
// Only enabled sources. DuePages deliberately does not filter that way: running
// a source by hand is an instruction, and it should work whether or not the
// scheduler is allowed to touch it.
//
// Nothing is locked or marked. A claim is a read, and work stops being
// claimable only once indexing it has moved its next_check_at — so the same
// address comes back on every claim until it has been read. Not handing it out
// twice is the caller's job, and the scheduler does it by remembering what is
// in flight.
func (r *Repo) ClaimWork(ctx context.Context, now time.Time, limit int) ([]Work, error) {
	rows, err := r.pool.Query(ctx, `
		WITH seeds AS (
			-- Only where the source has no pages at all. This is how a crawl
			-- starts and nothing more: once one page exists, its links carry the
			-- source forward. Claiming a seed after that would be a loop, because
			-- a seed that redirects is stored under the address it redirected to
			-- and would never match the one written in the config.
			SELECT u AS url, s.id AS source_id, 0 AS rank, 0::bigint AS ord
			FROM discovery.sources s, unnest(s.seed_urls) AS u
			WHERE s.enabled
			  AND NOT EXISTS (SELECT 1 FROM discovery.pages p WHERE p.source_id = s.id)
		), fresh AS (
			SELECT DISTINCT ON (l.url_key) l.url, p.source_id, 1 AS rank, l.page_id AS ord
			FROM discovery.page_links l
			JOIN discovery.pages p ON p.id = l.page_id
			JOIN discovery.sources s ON s.id = p.source_id AND s.enabled
			WHERE NOT EXISTS (SELECT 1 FROM discovery.pages t WHERE t.url_key = l.url_key)
			ORDER BY l.url_key, l.page_id DESC
		), due AS (
			-- Negated on purpose. One ORDER BY serves all three branches, and the
			-- other two want their largest value first. The page waiting longest
			-- has the smallest next_check_at, so negating puts it at the top of
			-- the same descending sort.
			SELECT p.url, p.source_id, 2 AS rank, -extract(epoch FROM p.next_check_at)::bigint AS ord
			FROM discovery.pages p
			JOIN discovery.sources s ON s.id = p.source_id AND s.enabled
			WHERE p.next_check_at IS NOT NULL AND p.next_check_at <= $1
		)
		SELECT url, coalesce(source_id,'') FROM (
			SELECT *, row_number() OVER (PARTITION BY source_id ORDER BY rank, ord DESC) AS turn
			FROM (
				SELECT * FROM seeds UNION ALL SELECT * FROM fresh UNION ALL SELECT * FROM due
			) q
		) r ORDER BY turn, rank, ord DESC LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Work
	for rows.Next() {
		var w Work
		if err := rows.Scan(&w.URL, &w.SourceID); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Unreachable takes a page out of the queue for good, with the reason on it.
//
// It is for an address we are not allowed to fetch: robots.txt closed a section
// we had already recorded pages under. Left in place such a page keeps filling
// the claim, is dropped after the fact, and starves the work that could have
// been done — a run comes back empty while there was plenty waiting. A null
// next_check_at is what both the claim and DuePages already skip.
//
// If the site opens the section again, a link to it makes it new work once more.
func (r *Repo) Unreachable(ctx context.Context, url, reason string, now time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE discovery.pages
		SET next_check_at = NULL, error = $2, last_fetched_at = $3
		WHERE url_key = $1`, domain.URLKey(url), reason, now)
	return err
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

// FailingPages lists the pages that keep refusing to be read, worst first.
//
// This is the view that did not exist. A run's error tally is per-run and gone
// on restart; the empty-pages list mixes a genuine failure in with every menu
// on the site. So a page that has failed forty times in a row was visible
// nowhere, and the only symptom was a crawl that never quite finished.
func (r *Repo) FailingPages(ctx context.Context, sourceID string, limit int) ([]Page, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+pageCols+`
		FROM discovery.pages
		WHERE consecutive_failures > 0 AND ($1 = '' OR source_id = $1)
		ORDER BY consecutive_failures DESC, last_fetched_at DESC NULLS LAST
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

// notDueLimit bounds how much of a source's schedule is held in memory for one
// run. Past it the crawl simply visits more than it strictly needs to, which
// is the old behaviour and not a failure.
const notDueLimit = 200000

// NotDueURLs are the pages of a source whose next check has not come around.
//
// The crawl consults this before following a link. Without it the schedule
// only ever applied to pages the run started from, and every page reachable by
// a link was refetched on every tick — so the backing off from one day to
// thirty, which is the whole economy of recrawling, did nothing at all for
// them.
func (r *Repo) NotDueURLs(ctx context.Context, sourceID string, now time.Time) (map[string]bool, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT url FROM discovery.pages
		WHERE ($1 = '' OR source_id = $1)
		  AND next_check_at IS NOT NULL AND next_check_at > $2
		LIMIT $3`, sourceID, now, notDueLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out[u] = true
	}
	return out, rows.Err()
}
