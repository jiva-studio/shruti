package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

func (r *Repo) SaveSource(ctx context.Context, s *domain.Archive) error {
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
		INSERT INTO discovery.sources (id, title, seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth, auth_headers, fetcher, recheck_min_s, recheck_max_s, author_override, script, kind)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,nullif($12,''),nullif($13,''),coalesce(nullif($14,''),'material'))
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title, seed_urls = EXCLUDED.seed_urls,
			enabled = EXCLUDED.enabled, crawl_delay_ms = EXCLUDED.crawl_delay_ms,
			crawl_workers = EXCLUDED.crawl_workers,
			max_depth = EXCLUDED.max_depth,
			recheck_min_s = EXCLUDED.recheck_min_s, recheck_max_s = EXCLUDED.recheck_max_s,
			author_override = EXCLUDED.author_override, script = EXCLUDED.script,
			-- An unsaid kind leaves the stored one alone: it decides whether a
			-- model is asked at all, and an edit that meant to toggle enabled
			-- must not send a whole archive through one.
			kind = coalesce(nullif($14,''), discovery.sources.kind),
			-- Empty headers leave the stored ones alone, so an ordinary edit
			-- does not silently sign the source out.
			fetcher = EXCLUDED.fetcher, auth_headers = CASE WHEN EXCLUDED.auth_headers = '{}'::jsonb
				THEN discovery.sources.auth_headers ELSE EXCLUDED.auth_headers END,
			updated_at = now()`,
		s.ID, s.Title, s.SeedURLs, s.Enabled, s.CrawlDelayMS, s.CrawlWorkers, s.MaxDepth, headers, s.Fetcher,
		s.RecheckMinS, s.RecheckMaxS, s.AuthorOverride, s.Script, s.Kind)
	return err
}

func (r *Repo) Source(ctx context.Context, id string) (*domain.Archive, error) {
	var s domain.Archive
	var headers []byte
	err := r.pool.QueryRow(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth, auth_headers, fetcher,
		       recheck_min_s, recheck_max_s, coalesce(author_override,''), coalesce(script,''), coalesce(kind,'material')
		FROM discovery.sources WHERE id = $1`, id,
	).Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.CrawlWorkers, &s.MaxDepth, &headers, &s.Fetcher,
		&s.RecheckMinS, &s.RecheckMaxS, &s.AuthorOverride, &s.Script, &s.Kind)
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

func (r *Repo) Sources(ctx context.Context) ([]domain.Archive, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, coalesce(title,''), seed_urls, enabled, crawl_delay_ms, crawl_workers, max_depth,
		       recheck_min_s, recheck_max_s, coalesce(author_override,''), coalesce(script,''), coalesce(kind,'material'),
		       coalesce(auth_headers, '{}'::jsonb) <> '{}'::jsonb
		FROM discovery.sources ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Archive
	for rows.Next() {
		var s domain.Archive
		if err := rows.Scan(&s.ID, &s.Title, &s.SeedURLs, &s.Enabled, &s.CrawlDelayMS, &s.CrawlWorkers, &s.MaxDepth,
			&s.RecheckMinS, &s.RecheckMaxS, &s.AuthorOverride, &s.Script, &s.Kind, &s.HasCredentials); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *Repo) StartRun(ctx context.Context, sourceID string, dryRun bool) (*domain.Run, error) {
	run := &domain.Run{DryRun: dryRun, Errors: map[string]int{}}
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
func (r *Repo) SaveProgress(ctx context.Context, run *domain.Run) error {
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

func (r *Repo) FinishRun(ctx context.Context, run *domain.Run) error {
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

func scanRun(row pgx.Row) (*domain.Run, error) {
	var run domain.Run
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

func (r *Repo) Run(ctx context.Context, id int64) (*domain.Run, error) {
	return scanRun(r.pool.QueryRow(ctx, `SELECT `+runCols+` FROM discovery.runs WHERE id = $1`, id))
}

func (r *Repo) Runs(ctx context.Context, sourceID string, limit int) ([]domain.Run, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+runCols+` FROM discovery.runs
		WHERE ($1 = '' OR source_id = $1)
		ORDER BY started_at DESC LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Run
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, rows.Err()
}
