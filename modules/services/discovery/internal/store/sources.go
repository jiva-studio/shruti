package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Source is a place to look. It is a seed URL and politeness settings — there
// is nothing here describing how the site is built, because nothing needs to
// know.
type Source struct {
	ID           string   `json:"id"`
	Title        string   `json:"title,omitempty"`
	SeedURLs     []string `json:"seed_urls"`
	Enabled      bool     `json:"enabled"`
	CrawlDelayMS int      `json:"crawl_delay_ms"`
	// MaxDepth bounds how far from the seed a crawl will follow links. Zero,
	// the default, means no bound.
	//
	// It guards against a site that generates endlessly long addresses — a
	// calendar with a perpetual "next month", a faceted filter, a looping
	// breadcrumb — which the visited set cannot catch because every address is
	// new. It is not a way to shape a crawl: setting it right needs advance
	// knowledge of how somebody else's site is laid out, which is the one thing
	// this service is built not to assume, and guessing it wrong silently
	// truncates an archive.
	MaxDepth int `json:"max_depth"`

	// AuthHeaders are sent with every request to this source. They are
	// credentials: never returned by the API, only set.
	AuthHeaders map[string]string `json:"auth_headers,omitempty"`
}

func (r *Repo) SaveSource(ctx context.Context, s *Source) error {
	if s.CrawlDelayMS <= 0 {
		s.CrawlDelayMS = 1000
	}
	// A nil map marshals to `null`, not `{}`, and the clause below only
	// recognised `{}` — so saving a source without its credentials silently
	// signed it out, which is exactly what that clause exists to prevent.
	headers := []byte("{}")
	if len(s.AuthHeaders) > 0 {
		var err error
		if headers, err = json.Marshal(s.AuthHeaders); err != nil {
			return err
		}
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO discovery.sources (id, title, seed_urls, enabled, crawl_delay_ms, max_depth, auth_headers)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title, seed_urls = EXCLUDED.seed_urls,
			enabled = EXCLUDED.enabled, crawl_delay_ms = EXCLUDED.crawl_delay_ms,
			max_depth = EXCLUDED.max_depth,
			-- Empty headers leave the stored ones alone, so an ordinary edit
			-- does not silently sign the source out.
			auth_headers = CASE WHEN EXCLUDED.auth_headers = '{}'::jsonb
				THEN discovery.sources.auth_headers ELSE EXCLUDED.auth_headers END,
			updated_at = now()`,
		s.ID, s.Title, s.SeedURLs, s.Enabled, s.CrawlDelayMS, s.MaxDepth, headers)
	return err
}

func (r *Repo) Source(ctx context.Context, id string) (*Source, error) {
	var s Source
	var headers []byte
	err := r.pool.QueryRow(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, max_depth, auth_headers
		FROM discovery.sources WHERE id = $1`, id,
	).Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.MaxDepth, &headers)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(headers, &s.AuthHeaders); err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *Repo) Sources(ctx context.Context) ([]Source, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, max_depth
		FROM discovery.sources ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Source
	for rows.Next() {
		var s Source
		if err := rows.Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.MaxDepth); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Run is one pass over a source, and the record of what it cost.
type Run struct {
	ID             int64          `json:"id"`
	SourceID       *string        `json:"source_id,omitempty"`
	DryRun         bool           `json:"dry_run"`
	StartedAt      time.Time      `json:"started_at"`
	FinishedAt     *time.Time     `json:"finished_at,omitempty"`
	PagesFetched   int            `json:"pages_fetched"`
	PagesUnchanged int            `json:"pages_unchanged"`
	ItemsFound     int            `json:"items_found"`
	ItemsNew       int            `json:"items_new"`
	ItemsChanged   int            `json:"items_changed"`
	Failures       int            `json:"failures"`
	Errors         map[string]int `json:"errors,omitempty"`
}

func (r *Repo) StartRun(ctx context.Context, sourceID string, dryRun bool) (*Run, error) {
	run := &Run{DryRun: dryRun, Errors: map[string]int{}}
	if sourceID != "" {
		run.SourceID = &sourceID
	}
	err := r.pool.QueryRow(ctx, `
		INSERT INTO discovery.runs (source_id, dry_run) VALUES ($1,$2)
		RETURNING id, started_at`, run.SourceID, dryRun,
	).Scan(&run.ID, &run.StartedAt)
	if err != nil {
		return nil, err
	}
	return run, nil
}

func (r *Repo) FinishRun(ctx context.Context, run *Run) error {
	errs, err := json.Marshal(run.Errors)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx, `
		UPDATE discovery.runs SET
			finished_at = now(), pages_fetched = $2, pages_unchanged = $3,
			items_found = $4, items_new = $5, items_changed = $6,
			failures = $7, errors = $8
		WHERE id = $1`,
		run.ID, run.PagesFetched, run.PagesUnchanged, run.ItemsFound,
		run.ItemsNew, run.ItemsChanged, run.Failures, errs)
	return err
}

const runCols = `id, source_id, dry_run, started_at, finished_at, pages_fetched,
	pages_unchanged, items_found, items_new, items_changed, failures, errors`

func scanRun(row pgx.Row) (*Run, error) {
	var run Run
	var errs []byte
	err := row.Scan(&run.ID, &run.SourceID, &run.DryRun, &run.StartedAt, &run.FinishedAt,
		&run.PagesFetched, &run.PagesUnchanged, &run.ItemsFound, &run.ItemsNew,
		&run.ItemsChanged, &run.Failures, &errs)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(errs, &run.Errors)
	return &run, nil
}

func (r *Repo) Run(ctx context.Context, id int64) (*Run, error) {
	return scanRun(r.pool.QueryRow(ctx, `SELECT `+runCols+` FROM discovery.runs WHERE id = $1`, id))
}

func (r *Repo) Runs(ctx context.Context, sourceID string, limit int) ([]Run, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+runCols+` FROM discovery.runs
		WHERE ($1 = '' OR source_id = $1)
		ORDER BY started_at DESC LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Run
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, rows.Err()
}
