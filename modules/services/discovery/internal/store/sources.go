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
	// CrawlWorkers is how many of this source's pages may be in flight at once.
	CrawlWorkers int `json:"crawl_workers"`
	// Fetcher names the reader this source needs. Empty is an ordinary request.
	Fetcher string `json:"fetcher,omitempty"`
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

	// RecheckMinS and RecheckMaxS bound how often a page of this source is read
	// again. Seconds, because that is what an operator types into a config file
	// and what the column holds; the schedule turns them into durations.
	RecheckMinS int `json:"recheck_min_s"`
	RecheckMaxS int `json:"recheck_max_s"`

	// Script names the extraction script that reads this source. Empty means
	// the source's own id, which is how a source named after its script has
	// always worked.
	//
	// It exists so that several sources can share one script: fourteen YouTube
	// channels are fourteen sources — each with its own speaker, its own
	// schedule, its own account — and one youtube.js.
	Script string `json:"script,omitempty"`

	// DefaultAuthor is who a recording is by when the page does not say. It is
	// the last word, never the first: what the page states always wins, or a
	// personal channel carrying a guest's lecture would file it under its owner.
	//
	// Empty is the right answer for an archive whose recordings are by many
	// people, and it is the default.
	DefaultAuthor string `json:"default_author,omitempty"`

	// AuthHeaders are sent with every request to this source. They are
	// credentials: never returned by the API, only set.
	AuthHeaders map[string]string `json:"auth_headers,omitempty"`

	// HasCredentials is derived, not stored. Sources deliberately does not read
	// the headers themselves — a listing has no business holding a set of
	// credentials in memory — but whether a source has any is worth showing.
	HasCredentials bool `json:"-"`
}

func (r *Repo) SaveSource(ctx context.Context, s *Source) error {
	if s.CrawlWorkers <= 0 {
		s.CrawlWorkers = 2
	}
	if s.CrawlDelayMS <= 0 {
		s.CrawlDelayMS = 1000
	}
	// The same numbers the column defaults carry, for a source built in Go
	// rather than inserted by hand. See migration 0001.
	if s.RecheckMinS <= 0 {
		s.RecheckMinS = 24 * 60 * 60
	}
	if s.RecheckMaxS < s.RecheckMinS {
		s.RecheckMaxS = max(30*24*60*60, s.RecheckMinS)
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
		INSERT INTO discovery.sources (id, title, seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth, auth_headers, fetcher, recheck_min_s, recheck_max_s, default_author, script)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,nullif($12,''),nullif($13,''))
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title, seed_urls = EXCLUDED.seed_urls,
			enabled = EXCLUDED.enabled, crawl_delay_ms = EXCLUDED.crawl_delay_ms,
			crawl_workers = EXCLUDED.crawl_workers,
			max_depth = EXCLUDED.max_depth,
			recheck_min_s = EXCLUDED.recheck_min_s, recheck_max_s = EXCLUDED.recheck_max_s,
			default_author = EXCLUDED.default_author, script = EXCLUDED.script,
			-- Empty headers leave the stored ones alone, so an ordinary edit
			-- does not silently sign the source out.
			fetcher = EXCLUDED.fetcher, auth_headers = CASE WHEN EXCLUDED.auth_headers = '{}'::jsonb
				THEN discovery.sources.auth_headers ELSE EXCLUDED.auth_headers END,
			updated_at = now()`,
		s.ID, s.Title, s.SeedURLs, s.Enabled, s.CrawlDelayMS, s.CrawlWorkers, s.MaxDepth, headers, s.Fetcher,
		s.RecheckMinS, s.RecheckMaxS, s.DefaultAuthor, s.Script)
	return err
}

func (r *Repo) Source(ctx context.Context, id string) (*Source, error) {
	var s Source
	var headers []byte
	err := r.pool.QueryRow(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth, auth_headers, fetcher,
		       recheck_min_s, recheck_max_s, coalesce(default_author,''), coalesce(script,'')
		FROM discovery.sources WHERE id = $1`, id,
	).Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.CrawlWorkers, &s.MaxDepth, &headers, &s.Fetcher,
		&s.RecheckMinS, &s.RecheckMaxS, &s.DefaultAuthor, &s.Script)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(headers, &s.AuthHeaders); err != nil {
		return nil, err
	}
	s.HasCredentials = len(s.AuthHeaders) > 0
	return &s, nil
}

func (r *Repo) Sources(ctx context.Context) ([]Source, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth,
		       recheck_min_s, recheck_max_s, coalesce(default_author,''), coalesce(script,''),
		       coalesce(auth_headers, '{}'::jsonb) <> '{}'::jsonb
		FROM discovery.sources ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Source
	for rows.Next() {
		var s Source
		if err := rows.Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.CrawlWorkers, &s.MaxDepth,
			&s.RecheckMinS, &s.RecheckMaxS, &s.DefaultAuthor, &s.Script, &s.HasCredentials); err != nil {
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
	// Interrupted means the process died while this run was going — a deploy,
	// a restart, a crash. Its counters are whatever it had managed to record,
	// and there is no finish time because we never learned one.
	Interrupted bool `json:"interrupted,omitempty"`
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

// SaveProgress writes a run's counters while it is still going.
//
// Without it the row reads all zeros until the moment it finishes, so a run in
// flight looks identical to one that has done nothing — and a run cut short by
// a restart keeps those zeros for ever, losing the record of work it really
// did.
func (r *Repo) SaveProgress(ctx context.Context, run *Run) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE discovery.runs SET
			pages_fetched = $2, pages_unchanged = $3, items_found = $4,
			items_new = $5, items_changed = $6, failures = $7
		WHERE id = $1`,
		run.ID, run.PagesFetched, run.PagesUnchanged, run.ItemsFound,
		run.ItemsNew, run.ItemsChanged, run.Failures)
	return err
}

// MarkInterruptedRuns closes the books on runs the previous process left open.
// Called once at boot: anything unfinished when we start cannot still be going.
func (r *Repo) MarkInterruptedRuns(ctx context.Context) (int, error) {
	tag, err := r.pool.Exec(ctx,
		`UPDATE discovery.runs SET interrupted = true WHERE finished_at IS NULL AND NOT interrupted`)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
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
	pages_unchanged, items_found, items_new, items_changed, failures, errors, interrupted`

func scanRun(row pgx.Row) (*Run, error) {
	var run Run
	var errs []byte
	err := row.Scan(&run.ID, &run.SourceID, &run.DryRun, &run.StartedAt, &run.FinishedAt,
		&run.PagesFetched, &run.PagesUnchanged, &run.ItemsFound, &run.ItemsNew,
		&run.ItemsChanged, &run.Failures, &errs, &run.Interrupted)
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
