// Package reconcile is the auth-side backfill for RevenueCat
// subscription state. Webhooks will be dropped — RC's 5-retry budget
// (~80 min) covers transient issues but not longer outages, and a
// silently-lost webhook leaves a paid user stuck on `tier='free'`
// indefinitely.
//
// This package runs as a goroutine inside the auth binary (no separate
// container — keeps the deploy story simple), ticking every
// `interval`. Each tick:
//
//  1. Pulls a bounded batch of users whose `tier_updated_at` is older
//     than `staleAfter` (or NULL for users who linked their RC account
//     but never matched a webhook).
//  2. For each, calls RC's `GET /v1/subscribers/{rc_app_user_id}` via
//     the existing rcclient.
//  3. Applies the snapshot through `service.ApplyRCSubscriberState` —
//     the same path the webhook handler uses, so a reconciled row is
//     indistinguishable from one driven by a live event (same outbox
//     emit, same tier_updated_at bump).
//
// Failures are logged and skipped — the next tick retries. Errors are
// not surfaced upstream because there's no operator to surface to;
// observability metrics (Phase 9) will turn the "stuck on free"
// signal into an alert.
package reconcile

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/auth/internal/metrics"
	"github.com/akdasa-studios/lectorium/auth/internal/rcclient"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

// permanentSkipDuration is how long we stay away from a user whose RC
// REST call returned a permanent failure (typically 401/403 from a
// misconfigured API key, or RC explicitly refusing the app_user_id).
// 24h is long enough that operators have time to notice the alert and
// rotate the key; short enough that a rogue skip won't strand a user
// for weeks if the underlying cause was a fluke.
const permanentSkipDuration = 24 * time.Hour

// Reconciler is the cron struct — the binary holds one per process.
type Reconciler struct {
	Pool          *pgxpool.Pool
	Users         *store.UserRepo
	WebhookEvents *store.WebhookEventRepo
	Svc           *service.Service
	RC            *rcclient.Client
	Interval      time.Duration // tick cadence; defaults to 6h
	StaleAfter    time.Duration // user is stale if tier_updated_at older than this; defaults to 24h
	BatchSize     int           // users per tick; defaults to 100
	// OrphanAfter is the cutoff for the orphan sweep: unprocessed
	// rc_webhook_events rows older than this get one final REST refetch
	// and (if still unmatched) are stamped processed with
	// error='orphaned_no_link'. Defaults to 7d — comfortably past RC's
	// 80-min retry budget so we don't trample an in-flight sequence.
	OrphanAfter time.Duration

	// Clock is injected for tests; defaults to time.Now. The skip table
	// uses it both to record skip-until timestamps and to evaluate
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

// Run blocks until ctx is cancelled. Safe to call once per process;
// the goroutine is small (no fan-out), one DB connection at a time.
//
// Synthetic-event semantics: each `event_id` we mint here is unique
// per (user, tick) so the idempotency guard in
// `service.ApplyRCSubscriberState` doesn't reject the apply — these
// aren't real RC events, they're our own retry triggers.
func (r *Reconciler) Run(ctx context.Context) error {
	r.applyDefaults()
	slog.InfoContext(ctx, "reconcile_loop_starting",
		slog.Duration("interval", r.Interval),
		slog.Duration("stale_after", r.StaleAfter),
		slog.Int("batch_size", r.BatchSize),
	)

	// First sweep fires immediately on boot so a freshly-started service
	// catches up without waiting a full interval. Subsequent ticks pace
	// off the Ticker — no drift, no double-fires.
	r.tick(ctx)

	tk := time.NewTicker(r.Interval)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "reconcile_loop_stopping")
			return ctx.Err()
		case <-tk.C:
			r.tick(ctx)
		}
	}
}

func (r *Reconciler) applyDefaults() {
	if r.Interval <= 0 {
		r.Interval = 6 * time.Hour
	}
	if r.StaleAfter <= 0 {
		r.StaleAfter = 24 * time.Hour
	}
	if r.BatchSize <= 0 {
		r.BatchSize = 100
	}
	if r.OrphanAfter <= 0 {
		r.OrphanAfter = 7 * 24 * time.Hour
	}
	if r.Clock == nil {
		r.Clock = time.Now
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

// tick is one sweep. Errors are logged but never bubbled — the loop
// is best-effort, the next tick will pick up whatever was left.
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
func (r *Reconciler) tick(ctx context.Context) {
	started := time.Now()
	stale, err := r.Users.ListStaleSubscribers(ctx, r.StaleAfter, r.BatchSize)
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
			if errors.Is(err, rcclient.ErrPermanent) {
				// Permanent → arm the skip window, bump the counter,
				// log loudly. Doesn't count as a "failed" tick — the
				// failure is RC's, not ours.
				until := r.markSkip(s.UserID)
				metrics.RCAPIPermanentTotal.Inc()
				metrics.RCAPIAuthFailedTotal.Inc()
				slog.ErrorContext(ctx, "reconcile_permanent_failure",
					slog.String("user_id", s.UserID.String()),
					slog.String("rc_app_user_id", s.RCAppUserID),
					slog.Time("skip_until", until),
					slog.String("err", err.Error()),
				)
				skipped++
				continue
			}
			if errors.Is(err, rcclient.ErrRateLimited) {
				// 429 → leave the user for the next sweep, count it
				// separately. Don't arm the skip window; the next tick
				// (6h by default) is well past any reasonable RC
				// Retry-After.
				metrics.RCAPIRateLimitedTotal.Inc()
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
		slog.Duration("elapsed", time.Since(started)),
	)
}

// orphanSweep is reconciliation Step 3 (plan 1.3).
//
// Anything in rc_webhook_events with processed_at=NULL and received_at
// older than OrphanAfter — that's an event whose rc_app_user_id never
// got bound to an auth.users row. RC's retry budget (~80 min) gave up
// long before this cutoff. We:
//
//  1. Re-fetch the RC subscriber once. If by some miracle the link
//     was bound between the webhook receipt and now, the apply path
//     succeeds and MarkProcessed runs inside ApplyRCSubscriberState.
//  2. If still unmatched → MarkOrphaned (stamp processed_at + set
//     error='orphaned_no_link'). The row stops counting against the
//     unprocessed_count metric; the cron stops scanning it.
//
// REST failures here are logged and skipped: the next tick retries.
// We never stamp processed on a network error — leaving the row alone
// is safer than burying a transient failure.
func (r *Reconciler) orphanSweep(ctx context.Context) (processed, failed int) {
	if r.WebhookEvents == nil {
		return 0, 0
	}
	orphans, err := r.WebhookEvents.ListOrphanedOlderThan(ctx, r.OrphanAfter, r.BatchSize)
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

func (r *Reconciler) sweepOne(ctx context.Context, o store.OrphanedEvent) error {
	resp, err := r.RC.GetSubscriber(ctx, o.AppUserID)
	if err != nil {
		return err
	}
	snap := service.SnapshotFromRCResponse(o.AppUserID, resp, time.Now())
	_, matched, err := r.Svc.ApplyRCSubscriberState(ctx, o.EventID, snap)
	if err != nil {
		return err
	}
	if matched {
		// Link finally resolved — ApplyRCSubscriberState ran MarkProcessed
		// for us. Counted in `processed`.
		return nil
	}
	// Still unmatched past the retry budget: bury the row so it stops
	// driving the unprocessed_count gauge.
	if err := r.WebhookEvents.MarkOrphaned(ctx, o.EventID); err != nil {
		return fmt.Errorf("mark orphaned: %w", err)
	}
	slog.InfoContext(ctx, "orphan_sweep_marked",
		slog.String("event_id", o.EventID),
		slog.String("rc_app_user_id", o.AppUserID),
		slog.Time("received_at", o.ReceivedAt),
	)
	return nil
}

func (r *Reconciler) reconcileOne(ctx context.Context, s store.StaleSubscriber) error {
	resp, err := r.RC.GetSubscriber(ctx, s.RCAppUserID)
	if err != nil && !errors.Is(err, rcclient.ErrSubscriberNotFound) {
		// 404 is a soft success — apply with the empty body so the
		// user reverts to tier=free if RC has no record. Anything
		// else is bubbled up so tick() can classify and decide skip
		// vs retry.
		return err
	}
	snap := service.SnapshotFromRCResponse(s.RCAppUserID, resp, r.Clock())
	// Synthetic event id — `reconcile:<user>:<unix>` is unique per
	// (user, tick) so the dedup table never short-circuits the apply.
	// Doesn't collide with real RC `event.id` because of the prefix.
	eventID := "reconcile:" + s.UserID.String() + ":" + time.Now().UTC().Format("20060102T150405Z")
	// ApplyRCSubscriberState returns matched=false (no error) when the
	// rc_app_user_id is no longer linked to any auth.users row — the
	// apply already logged that; nothing else to do here.
	if _, _, err := r.Svc.ApplyRCSubscriberState(ctx, eventID, snap); err != nil {
		return err
	}
	return nil
}
