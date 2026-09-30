// Package reconcile is the backstop for RevenueCat subscription state: a
// webhook RevenueCat stopped retrying (its budget is about 80 minutes) would
// otherwise leave a paying user on free for good.
//
// Each Tick:
//
//  1. Pulls a bounded batch of users whose tier state is older than
//     StaleAfter, or was never synced.
//  2. Refetches each from RevenueCat and applies the snapshot through
//     rcsync.Service.Apply, the path the webhook takes, so a reconciled row
//     is indistinguishable from a webhook-driven one.
//  3. Sweeps webhook events that stayed unmatched past OrphanAfter.
//
// Failures are logged and left for the next tick.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// permanentSkipDuration is how long we stay away from a user whose RC
// REST call returned a permanent failure (typically 401/403 from a
// misconfigured API key, or RC explicitly refusing the app_user_id).
// 24h is long enough that operators have time to notice the alert and
// rotate the key; short enough that a rogue skip won't strand a user
// for weeks if the underlying cause was a fluke.
const permanentSkipDuration = 24 * time.Hour

// Reconciler sweeps stale subscribers and orphaned webhook events; the
// binary holds one per process and paces its ticks.
type Reconciler struct {
	Store      ports.Store
	Sync       *rcsync.Service
	RC         ports.RevenueCat
	Metrics    ports.RevenueCatMetrics
	StaleAfter time.Duration // user is stale if tier_updated_at older than this; defaults to 24h
	BatchSize  int           // users per tick; defaults to 100
	// OrphanAfter is the cutoff for the orphan sweep: unprocessed
	// rc_webhook_events rows older than this get one final REST refetch
	// and (if still unmatched) are stamped processed with
	// error='orphaned_no_link'. Defaults to 7d — comfortably past RC's
	// 80-min retry budget so we don't trample an in-flight sequence.
	OrphanAfter time.Duration

	// Clock is required. The skip table uses it both to record skip-until timestamps and to evaluate
	// whether a user is still within their skip window.
	Clock func() time.Time

	// SkipDuration overrides permanentSkipDuration for tests. Zero
	// falls back to the package default.
	SkipDuration time.Duration

	// skipUntil maps user_id → "don't touch before this time". Entries
	// are written when GetSubscriber returns ErrPermanent and read at
	// the top of reconcileOne. Pure in-process state — a restart clears
	// it (acceptable: on restart the first sweep will re-hit RC, see
	// the same permanent error, log + skip again).
	skipUntil   map[uuid.UUID]time.Time
	skipUntilMu sync.Mutex
}

// ApplyDefaults fills every unset tuning field with its default.
func (r *Reconciler) ApplyDefaults() {
	if r.StaleAfter <= 0 {
		r.StaleAfter = 24 * time.Hour
	}
	if r.BatchSize <= 0 {
		r.BatchSize = 100
	}
	if r.OrphanAfter <= 0 {
		r.OrphanAfter = 7 * 24 * time.Hour
	}
	if r.SkipDuration <= 0 {
		r.SkipDuration = permanentSkipDuration
	}
	if r.skipUntil == nil {
		r.skipUntil = make(map[uuid.UUID]time.Time)
	}
}

// shouldSkip reports whether `uid` is currently within a permanent-error
// skip window. The check is best-effort: a stale entry doesn't matter
// for correctness, the next sweep just retries.
func (r *Reconciler) shouldSkip(uid uuid.UUID) (bool, time.Time) {
	r.skipUntilMu.Lock()
	defer r.skipUntilMu.Unlock()
	until, ok := r.skipUntil[uid]
	if !ok {
		return false, time.Time{}
	}
	if r.Clock().Before(until) {
		return true, until
	}
	// Window elapsed — clear so the map doesn't grow unbounded for
	// long-lived processes.
	delete(r.skipUntil, uid)
	return false, time.Time{}
}

// markSkip records a permanent-failure skip window for `uid`.
func (r *Reconciler) markSkip(uid uuid.UUID) time.Time {
	until := r.Clock().Add(r.SkipDuration)
	r.skipUntilMu.Lock()
	r.skipUntil[uid] = until
	r.skipUntilMu.Unlock()
	return until
}

// Tick is one sweep. Errors are logged but never returned — the next tick
// picks up whatever was left.
//
// Two phases:
//  1. Stale-user backfill — re-fetch RC state for users whose
//     tier_updated_at is older than StaleAfter. Catches dropped
//     webhooks.
//  2. Orphan sweep — re-fetch unprocessed webhook events whose link
//     never materialised. Anything still unmatched past
//     OrphanAfter (7d) is stamped processed with
//     error='orphaned_no_link' so it stops feeding the
//     unprocessed_count metric.
func (r *Reconciler) Tick(ctx context.Context) {
	r.ApplyDefaults()
	started := r.Clock()
	stale, err := r.Store.Users().ListStaleSubscribers(ctx, r.StaleAfter, r.BatchSize)
	if err != nil {
		slog.ErrorContext(ctx, "reconcile_list_failed", slog.String("err", err.Error()))
	}

	var processed, failed, skipped int
	for _, s := range stale {
		if ctx.Err() != nil {
			break
		}
		// Skip users whose RC call returned a permanent failure
		// recently. The skip window is per-user so an API-key
		// misconfiguration doesn't burn quota on the whole batch
		// every tick.
		if skip, until := r.shouldSkip(s.UserID); skip {
			skipped++
			slog.DebugContext(ctx, "reconcile_skip_permanent",
				slog.String("user_id", s.UserID.String()),
				slog.Time("until", until),
			)
			continue
		}
		if err := r.reconcileOne(ctx, s); err != nil {
			if errors.Is(err, subscription.ErrPermanent) {
				// Permanent → arm the skip window, bump the counter,
				// log loudly. Doesn't count as a "failed" tick — the
				// failure is RC's, not ours.
				until := r.markSkip(s.UserID)
				r.Metrics.APIPermanent()
				r.Metrics.APIAuthFailed()
				slog.ErrorContext(ctx, "reconcile_permanent_failure",
					slog.String("user_id", s.UserID.String()),
					slog.String("rc_app_user_id", s.RCAppUserID),
					slog.Time("skip_until", until),
					slog.String("err", err.Error()),
				)
				skipped++
				continue
			}
			if errors.Is(err, subscription.ErrRateLimited) {
				// 429 → leave the user for the next sweep, count it
				// separately. Don't arm the skip window; the next tick
				// (6h in cmd/auth) is well past any reasonable RC
				// Retry-After.
				r.Metrics.APIRateLimited()
			}
			failed++
			slog.WarnContext(ctx, "reconcile_one_failed",
				slog.String("user_id", s.UserID.String()),
				slog.String("rc_app_user_id", s.RCAppUserID),
				slog.String("err", err.Error()),
			)
			continue
		}
		processed++
	}

	// Step 2: orphan sweep. Always runs, even when phase 1 was idle —
	// the two surfaces are independent.
	orphanProcessed, orphanFailed := r.orphanSweep(ctx)

	if len(stale) == 0 && orphanProcessed == 0 && orphanFailed == 0 {
		slog.DebugContext(ctx, "reconcile_idle_tick")
		return
	}

	slog.InfoContext(ctx, "reconcile_tick_done",
		slog.Int("processed", processed),
		slog.Int("failed", failed),
		slog.Int("skipped", skipped),
		slog.Int("orphan_processed", orphanProcessed),
		slog.Int("orphan_failed", orphanFailed),
		slog.Duration("elapsed", r.Clock().Sub(started)),
	)
}

// orphanSweep retires webhook events whose link never materialised.
//
// Anything in rc_webhook_events with processed_at=NULL and received_at
// older than OrphanAfter — that's an event whose rc_app_user_id never
// got bound to an auth.users row. RC's retry budget (~80 min) gave up
// long before this cutoff. We:
//
//  1. Re-fetch the RC subscriber once. If by some miracle the link
//     was bound between the webhook receipt and now, the apply path
//     succeeds and MarkProcessed runs inside Apply.
//  2. If still unmatched → MarkOrphaned (stamp processed_at + set
//     error='orphaned_no_link'). The row stops counting against the
//     unprocessed_count metric; the cron stops scanning it.
//
// REST failures here are logged and skipped: the next tick retries.
// We never stamp processed on a network error — leaving the row alone
// is safer than burying a transient failure.
func (r *Reconciler) orphanSweep(ctx context.Context) (processed, failed int) {
	orphans, err := r.Store.WebhookEvents().ListOrphanedOlderThan(ctx, r.OrphanAfter, r.BatchSize)
	if err != nil {
		slog.ErrorContext(ctx, "orphan_sweep_list_failed", slog.String("err", err.Error()))
		return 0, 0
	}
	for _, o := range orphans {
		if ctx.Err() != nil {
			break
		}
		if err := r.sweepOne(ctx, o); err != nil {
			failed++
			slog.WarnContext(ctx, "orphan_sweep_one_failed",
				slog.String("event_id", o.EventID),
				slog.String("rc_app_user_id", o.AppUserID),
				slog.String("err", err.Error()),
			)
			continue
		}
		processed++
	}
	return processed, failed
}

func (r *Reconciler) sweepOne(ctx context.Context, o subscription.OrphanedEvent) error {
	fetchedAt := r.Clock()
	resp, err := r.RC.GetSubscriber(ctx, o.AppUserID)
	if err != nil {
		return err
	}
	snap := rcsync.SnapshotFromRCResponse(o.AppUserID, resp, fetchedAt)
	_, matched, err := r.Sync.Apply(ctx, o.EventID, snap)
	if err != nil {
		return err
	}
	if matched {
		// Link finally resolved — Apply ran MarkProcessed
		// for us. Counted in `processed`.
		return nil
	}
	// Still unmatched past the retry budget: bury the row so it stops
	// driving the unprocessed_count gauge.
	if err := r.Store.WebhookEvents().MarkOrphaned(ctx, o.EventID); err != nil {
		return fmt.Errorf("mark orphaned: %w", err)
	}
	slog.InfoContext(ctx, "orphan_sweep_marked",
		slog.String("event_id", o.EventID),
		slog.String("rc_app_user_id", o.AppUserID),
		slog.Time("received_at", o.ReceivedAt),
	)
	return nil
}

func (r *Reconciler) reconcileOne(ctx context.Context, s subscription.StaleSubscriber) error {
	// A customer RevenueCat does not know reverts to free; any other error
	// goes back to Tick to decide between skip and retry.
	snap, err := r.Sync.FetchSnapshot(ctx, s.RCAppUserID)
	if err != nil {
		return err
	}
	// Synthetic event id — `reconcile:<user>:<unix>` is unique per
	// (user, tick) so the dedup table never short-circuits the apply.
	// Doesn't collide with real RC `event.id` because of the prefix.
	eventID := "reconcile:" + s.UserID.String() + ":" + r.Clock().UTC().Format("20060102T150405Z")
	// Apply returns matched=false (no error) when the
	// rc_app_user_id is no longer linked to any auth.users row — the
	// apply already logged that; nothing else to do here.
	if _, _, err := r.Sync.Apply(ctx, eventID, snap); err != nil {
		return err
	}
	return nil
}
