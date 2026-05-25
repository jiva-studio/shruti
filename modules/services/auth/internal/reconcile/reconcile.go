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
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/auth/internal/rcclient"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

// Reconciler is the cron struct — the binary holds one per process.
type Reconciler struct {
	Pool       *pgxpool.Pool
	Users      *store.UserRepo
	Svc        *service.Service
	RC         *rcclient.Client
	Interval   time.Duration // tick cadence; defaults to 6h
	StaleAfter time.Duration // user is stale if tier_updated_at older than this; defaults to 24h
	BatchSize  int           // users per tick; defaults to 100
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
}

// tick is one sweep. Errors are logged but never bubbled — the loop
// is best-effort, the next tick will pick up whatever was left.
func (r *Reconciler) tick(ctx context.Context) {
	started := time.Now()
	stale, err := r.Users.ListStaleSubscribers(ctx, r.StaleAfter, r.BatchSize)
	if err != nil {
		slog.ErrorContext(ctx, "reconcile_list_failed", slog.String("err", err.Error()))
		return
	}
	if len(stale) == 0 {
		slog.DebugContext(ctx, "reconcile_idle_tick")
		return
	}

	var processed, failed int
	for _, s := range stale {
		if ctx.Err() != nil {
			break
		}
		if err := r.reconcileOne(ctx, s); err != nil {
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
	slog.InfoContext(ctx, "reconcile_tick_done",
		slog.Int("processed", processed),
		slog.Int("failed", failed),
		slog.Duration("elapsed", time.Since(started)),
	)
}

func (r *Reconciler) reconcileOne(ctx context.Context, s store.StaleSubscriber) error {
	resp, err := r.RC.GetSubscriber(ctx, s.RCAppUserID)
	if err != nil {
		return err
	}
	snap := service.SnapshotFromRCResponse(s.RCAppUserID, resp, time.Now())
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
