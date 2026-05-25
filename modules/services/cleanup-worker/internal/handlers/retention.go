// Retention sweep: prune processed bookkeeping rows from auth.rc_webhook_events
// and app.outbox after their respective grace windows expire.
//
// Why here and not in internal/cron: the cron package is reserved for jobs
// that DELETE business rows and feed back into the outbox (anon cleanup →
// user.deleted). Retention is plain housekeeping on tables the worker already
// owns conceptually (it consumes app.outbox, the auth service produces
// auth.rc_webhook_events) — there's no fan-out, no trigger, just bounded
// DELETEs on a daily cadence. Keeping it next to the event handlers keeps
// the wiring trivial: main.go starts one goroutine.
//
// Both tables grow unboundedly otherwise. The unprocessed-event partial
// indexes stay cheap regardless, but the heap and the seq-scan'd
// observability queries (`SELECT count(*) WHERE processed_at IS NULL` for
// alerting on stuck rows) get noisier as processed rows accumulate.
//
// Retention windows (from the plan):
//   - auth.rc_webhook_events: 90 days after processed_at. Long enough for an
//     ops investigation of stale-Pro-window incidents (RC retry budget is
//     80min, reconcile cron sweeps every 6h, anything beyond a week is
//     archaeology) but bounded so the table doesn't outgrow its disk slice.
//   - app.outbox: 30 days after processed_at. Outbox is purely a fan-out log;
//     once the consumer marked it processed and a month has passed there's
//     no diagnostic value in keeping it.

package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// retentionBatchSize caps how many rows a single DELETE statement removes.
// 1000 keeps the row-lock footprint small enough that producer INSERTs never
// stall behind us, and the looped DELETE drains anything larger over multiple
// iterations. Same value used by the anon-cleanup cron — adopted by analogy
// rather than measurement; tune later if Postgres CPU shows spikes.
const retentionBatchSize = 1000

// Retention bundles state for the periodic retention sweep. Build once at
// boot, hand to a goroutine in main.
type Retention struct {
	Pool     *pgxpool.Pool
	Interval time.Duration

	// WebhookEventsTTL keeps processed RC webhook log rows for this long
	// before deletion. Plan: 90 days.
	WebhookEventsTTL time.Duration
	// OutboxTTL keeps processed outbox rows for this long. Plan: 30 days.
	OutboxTTL time.Duration

	// deletedTotal is a per-table running counter exposed via Stats(). No
	// Prometheus client in cleanup-worker yet — operators read it out of
	// the structured "retention_sweep_done" log line or via a future
	// /metrics endpoint. Tracked here to keep the contract testable.
	deletedRCWebhookEvents atomic.Int64
	deletedOutbox          atomic.Int64
}

// RetentionStats is the public snapshot used by /metrics or tests. Keyed by
// table name to mirror the planned Prometheus label `cleanup_retention_deleted_total{table}`.
type RetentionStats struct {
	DeletedByTable map[string]int64
}

// Stats returns a point-in-time snapshot of the deleted-total counters.
func (r *Retention) Stats() RetentionStats {
	return RetentionStats{
		DeletedByTable: map[string]int64{
			"auth.rc_webhook_events": r.deletedRCWebhookEvents.Load(),
			"app.outbox":             r.deletedOutbox.Load(),
		},
	}
}

// Run blocks until ctx is cancelled. Startup contract mirrors the outbox
// worker and the anon-cleanup cron: do one sweep immediately so a long-down
// instance catches up on boot, then tick on Interval.
func (r *Retention) Run(ctx context.Context) error {
	if r.Interval <= 0 {
		return fmt.Errorf("retention: Interval must be > 0, got %s", r.Interval)
	}
	if r.WebhookEventsTTL <= 0 || r.OutboxTTL <= 0 {
		return fmt.Errorf("retention: TTLs must be > 0 (webhook=%s outbox=%s)",
			r.WebhookEventsTTL, r.OutboxTTL)
	}

	slog.InfoContext(ctx, "retention_starting",
		slog.Duration("interval", r.Interval),
		slog.Duration("webhook_events_ttl", r.WebhookEventsTTL),
		slog.Duration("outbox_ttl", r.OutboxTTL),
	)

	if err := r.SweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.WarnContext(ctx, "retention_initial_sweep_failed", slog.String("err", err.Error()))
		// Non-fatal: the ticker will retry on the next interval.
	}

	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := r.SweepOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, "retention_sweep_failed", slog.String("err", err.Error()))
			}
		}
	}
}

// SweepOnce runs one full retention pass — both tables, drained to zero in
// retentionBatchSize chunks. Exposed for tests so they can deterministically
// trigger a tick without spinning the goroutine.
func (r *Retention) SweepOnce(ctx context.Context) error {
	started := time.Now()

	webhookDeleted, err := r.sweepTable(ctx,
		"auth.rc_webhook_events",
		r.WebhookEventsTTL,
		// processed_at is the timestamp we age from. unprocessed rows stay —
		// orphan handling lives in the reconcile cron, not here.
		`DELETE FROM auth.rc_webhook_events
		   WHERE event_id IN (
		     SELECT event_id FROM auth.rc_webhook_events
		      WHERE processed_at IS NOT NULL
		        AND processed_at < now() - make_interval(secs => $1)
		      LIMIT $2
		   )`,
	)
	if err != nil {
		return fmt.Errorf("sweep auth.rc_webhook_events: %w", err)
	}
	r.deletedRCWebhookEvents.Add(int64(webhookDeleted))

	outboxDeleted, err := r.sweepTable(ctx,
		"app.outbox",
		r.OutboxTTL,
		// DELETE-via-IN-with-LIMIT pattern: Postgres doesn't accept LIMIT on a
		// top-level DELETE, so we self-join through the primary key. Cheap
		// because the partial index outbox_unprocessed_idx is irrelevant here
		// (we're hitting the processed_at IS NOT NULL side) — a seq scan over
		// rows aging out daily is fine until the heap gets big, at which point
		// a separate processed-rows index would be the proper fix.
		`DELETE FROM app.outbox
		   WHERE id IN (
		     SELECT id FROM app.outbox
		      WHERE processed_at IS NOT NULL
		        AND processed_at < now() - make_interval(secs => $1)
		      LIMIT $2
		   )`,
	)
	if err != nil {
		return fmt.Errorf("sweep app.outbox: %w", err)
	}
	r.deletedOutbox.Add(int64(outboxDeleted))

	slog.InfoContext(ctx, "retention_sweep_done",
		slog.Int("auth_rc_webhook_events_deleted", webhookDeleted),
		slog.Int("app_outbox_deleted", outboxDeleted),
		slog.Duration("took", time.Since(started)),
	)
	return nil
}

// sweepTable runs the bounded DELETE in a loop until a single iteration
// removes zero rows. Each iteration is its own statement (not transaction-
// wrapped): the producer can keep INSERTing between batches without waiting
// for a long retention tx to commit.
//
// secs is preferred over days for the make_interval call so the helper can
// be tested with sub-day TTLs without rounding to zero. Callers always pass
// real-world durations (days/months); the conversion to seconds is just an
// interface convenience.
func (r *Retention) sweepTable(ctx context.Context, table string, ttl time.Duration, query string) (int, error) {
	total := 0
	secs := int(ttl.Seconds())
	if secs <= 0 {
		// Defensive: Run() validates TTL > 0, but a sub-second TTL would land
		// here as 0 and match every row. Force at least 1 second of grace.
		secs = 1
	}

	for {
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		default:
		}

		ct, err := r.Pool.Exec(ctx, query, secs, retentionBatchSize)
		if err != nil {
			return total, fmt.Errorf("delete batch from %s: %w", table, err)
		}
		n := int(ct.RowsAffected())
		total += n
		if n < retentionBatchSize {
			// Either we hit the tail of the eligible set, or there was never
			// anything to do this tick. Either way: stop looping.
			return total, nil
		}
	}
}
