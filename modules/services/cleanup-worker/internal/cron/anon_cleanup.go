// Package cron hosts the cleanup-worker's scheduled jobs.
//
// Distinct from internal/worker (which is event-driven via LISTEN/NOTIFY +
// the outbox sweep): jobs here run on a wall-clock cadence and DELETE
// rows directly. They don't replace the outbox loop — they FEED it. The
// anon-account cleanup, for instance, just DELETEs from auth.users; the
// existing AFTER DELETE trigger emits user.deleted into app.outbox and
// the regular worker loop picks it up to purge Langfuse traces.
package cron

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AnonCleanup deletes anonymous (device-only) auth.users rows whose newest
// refresh_token is older than TTL. "Anonymous" = the user has no identity
// row with a provider other than 'device'; the moment they sign in with
// Google/Apple, they're a real account and we leave them alone.
//
// We use refresh_tokens.created_at (not expires_at) as the activity proxy
// on purpose: auth's RefreshTTL is 90 days, so expires_at gives a 15-month
// effective window (12mo idle + 3mo token life) instead of the policy 12mo.
type AnonCleanup struct {
	Pool     *pgxpool.Pool
	Interval time.Duration
	TTL      time.Duration
}

// Run blocks until ctx is cancelled. Startup contract mirrors the outbox
// worker: do one sweep immediately (a long-down instance catches up on
// boot), then start the ticker for the configured interval.
func (c *AnonCleanup) Run(ctx context.Context) error {
	if c.TTL <= 0 {
		// Safety: caller should have filtered this out and never started
		// the goroutine — but if it slipped through, ticking on a zero
		// duration would panic. Treat as disabled.
		slog.WarnContext(ctx, "anon_cleanup_disabled_ttl_zero")
		<-ctx.Done()
		return ctx.Err()
	}

	slog.InfoContext(ctx, "anon_cleanup_starting",
		slog.Duration("interval", c.Interval),
		slog.Duration("ttl", c.TTL),
	)

	if err := c.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.WarnContext(ctx, "anon_cleanup_initial_sweep_failed", slog.String("err", err.Error()))
		// Non-fatal: the ticker will retry on the next interval.
	}

	t := time.NewTicker(c.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := c.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, "anon_cleanup_sweep_failed", slog.String("err", err.Error()))
			}
		}
	}
}

// sweepOnce runs one delete cycle. Wrapped in a single transaction so
// either every row goes (and emits its outbox row via the trigger) or
// none do; partial progress on a connection drop is fine — the next
// tick will pick up whatever's still over the TTL.
//
// RETURNING id is purely for the count + per-user log line; the trigger
// owns the actual outbox emission, so we don't need to thread the ids
// anywhere else.
func (c *AnonCleanup) sweepOnce(ctx context.Context) error {
	started := time.Now()

	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// `make_interval(days => $1)` avoids binding an interval-typed parameter
	// (pgx would need explicit `pgtype.Interval`) and keeps the TTL knob a
	// plain integer count of days derived from the Go duration.
	days := int(c.TTL / (24 * time.Hour))
	if days <= 0 {
		// TTL smaller than a day: round up to 1 so we never pass 0 (which
		// would match every row). Sub-day TTLs only matter in tests; this
		// keeps the contract "TTL>0 means at least one day of grace".
		days = 1
	}

	const q = `
		DELETE FROM auth.users
		WHERE id IN (
		  SELECT u.id FROM auth.users u
		  WHERE NOT EXISTS (
		    SELECT 1 FROM auth.identities i
		    WHERE i.user_id = u.id AND i.provider != 'device'
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM auth.refresh_tokens rt
		    WHERE rt.user_id = u.id
		      AND rt.created_at > now() - make_interval(days => $1)
		  )
		)
		RETURNING id
	`

	rows, err := tx.Query(ctx, q, days)
	if err != nil {
		return fmt.Errorf("delete anon users: %w", err)
	}
	var deleted []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return fmt.Errorf("scan deleted id: %w", err)
		}
		deleted = append(deleted, id)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate deleted ids: %w", err)
	}
	rows.Close()

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	slog.InfoContext(ctx, "anon_cleanup_swept",
		slog.Int("deleted", len(deleted)),
		slog.Duration("took", time.Since(started)),
	)
	for _, id := range deleted {
		slog.InfoContext(ctx, "anon_cleanup_deleted_user", slog.String("user_id", id))
	}
	return nil
}
