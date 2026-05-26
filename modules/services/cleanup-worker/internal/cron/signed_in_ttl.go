package cron

// SignedInTTL is the long-tail cleanup for SIGNED-IN users — the analog
// of AnonCleanup (PR #637) but for the OTHER side of the identity
// spectrum.
//
// Activity proxy: refresh_tokens.created_at. A user whose newest
// refresh_token is older than TTL hasn't touched the app in TTL —
// Apple/Google refresh tokens are good for years in practice, so a true
// 24mo gap of zero refreshes likely means the user has uninstalled,
// lost the device, or is dead.
//
// Selection invariants:
//   - "Signed-in" = has at least one auth.identities row with provider
//     != 'device'. Anon (device-only) users are AnonCleanup territory;
//     skipping them here avoids double-processing the population.
//   - The DELETE cascades through auth.identities and auth.refresh_tokens
//     (FK ON DELETE CASCADE), and the auth.users AFTER DELETE trigger
//     emits 'user.deleted' into app.outbox — the same downstream cleanup
//     path AnonCleanup uses (Langfuse purge handler picks it up).
//
// Dry-run mode: queries the same predicate but doesn't DELETE. The
// initial production deployment runs DryRun=true so the operator can
// eyeball the "would-delete" log lines before letting it loose; flip to
// false after 1-2 weeks of stable output.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// SignedInTTL deletes signed-in users idle for longer than TTL.
type SignedInTTL struct {
	Pool     *pgxpool.Pool
	Interval time.Duration
	TTL      time.Duration
	DryRun   bool
}

// Run blocks until ctx is cancelled. Mirrors AnonCleanup.Run — initial
// sweep on boot (catch up a long-down instance), then tick every
// Interval. A failed sweep is logged but never fatal.
func (c *SignedInTTL) Run(ctx context.Context) error {
	if c.TTL <= 0 {
		slog.WarnContext(ctx, "signed_in_ttl_disabled_ttl_zero")
		<-ctx.Done()
		return ctx.Err()
	}

	slog.InfoContext(ctx, "signed_in_ttl_starting",
		slog.Duration("interval", c.Interval),
		slog.Duration("ttl", c.TTL),
		slog.Bool("dry_run", c.DryRun),
	)

	if err := c.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.WarnContext(ctx, "signed_in_ttl_initial_sweep_failed", slog.String("err", err.Error()))
	}

	t := time.NewTicker(c.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := c.sweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, "signed_in_ttl_sweep_failed", slog.String("err", err.Error()))
			}
		}
	}
}

// sweepOnce runs one delete cycle. Wrapped in a transaction so the
// DELETE + the cascade triggers' outbox writes either all land or none
// do; a partial sweep on a connection drop is fine — the next tick
// picks up whatever remains over TTL.
//
// Dry-run path runs the same predicate as a SELECT and logs the would-
// delete ids. No transaction needed (no mutation).
func (c *SignedInTTL) sweepOnce(ctx context.Context) error {
	started := time.Now()

	// Predicate uses `make_interval(days => $1)` for the same reason
	// AnonCleanup does: avoid pgtype.Interval binding, keep TTL knob a
	// plain integer count of days.
	days := int(c.TTL / (24 * time.Hour))
	if days <= 0 {
		days = 1
	}

	const predicate = `
		EXISTS (
		  SELECT 1 FROM auth.identities i
		  WHERE i.user_id = u.id AND i.provider != 'device'
		)
		AND NOT EXISTS (
		  SELECT 1 FROM auth.refresh_tokens rt
		  WHERE rt.user_id = u.id
		    AND rt.created_at > now() - make_interval(days => $1)
		)
	`

	if c.DryRun {
		// SELECT the matching ids without deleting. Used during the
		// initial 1-2 week observation window — operator scans the
		// would-delete log lines for false positives before flipping to
		// DryRun=false.
		q := `SELECT u.id::text FROM auth.users u WHERE ` + predicate
		rows, err := c.Pool.Query(ctx, q, days)
		if err != nil {
			return fmt.Errorf("dryrun query: %w", err)
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return fmt.Errorf("dryrun scan: %w", err)
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("dryrun iterate: %w", err)
		}
		slog.InfoContext(ctx, "signed_in_ttl_dryrun",
			slog.Int("would_delete", len(ids)),
			slog.Duration("took", time.Since(started)),
		)
		for _, id := range ids {
			slog.InfoContext(ctx, "signed_in_ttl_dryrun_user", slog.String("user_id", id))
		}
		return nil
	}

	tx, err := c.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	q := `
		DELETE FROM auth.users
		WHERE id IN (
		  SELECT u.id FROM auth.users u WHERE ` + predicate + `
		)
		RETURNING id
	`
	rows, err := tx.Query(ctx, q, days)
	if err != nil {
		return fmt.Errorf("delete signed-in users: %w", err)
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

	slog.InfoContext(ctx, "signed_in_ttl_swept",
		slog.Int("deleted", len(deleted)),
		slog.Duration("took", time.Since(started)),
	)
	for _, id := range deleted {
		slog.InfoContext(ctx, "signed_in_ttl_deleted_user", slog.String("user_id", id))
	}
	return nil
}
