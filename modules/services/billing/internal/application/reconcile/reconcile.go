// Package reconcile re-drives stuck billing orders. IPN delivery is never
// trusted: a webhook can be lost, or a downstream (Paymento verify / auth
// grant) can be down when the IPN arrives. This worker ticks periodically,
// picks orders that haven't moved recently and are still mid-flight
// (created/verified/granted) or expired with their last verify unanswered, and
// re-runs the missing step through the same fulfilment the webhook uses — so a
// payment that completed while billing/auth/Paymento was down self-heals.
//
// It also expires `created` orders that never got approved past a long cutoff.
package reconcile

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/billing/internal/ports"
)

// Driver advances one order as far as it can go.
type Driver interface {
	Drive(ctx context.Context, orderID uuid.UUID) error
}

// Worker is the reconcile loop.
type Worker struct {
	Orders ports.Orders
	Driver Driver

	Interval    time.Duration // tick cadence; defaults to 2m
	StuckAfter  time.Duration // re-drive orders untouched longer than this; defaults to 60s
	ExpireAfter time.Duration // created orders older than this with no approval → expired; defaults to 24h
	BatchSize   int           // orders per tick; defaults to 100
}

func (w *Worker) applyDefaults() {
	if w.Interval <= 0 {
		w.Interval = 2 * time.Minute
	}
	if w.StuckAfter <= 0 {
		w.StuckAfter = 60 * time.Second
	}
	if w.ExpireAfter <= 0 {
		w.ExpireAfter = 24 * time.Hour
	}
	if w.BatchSize <= 0 {
		w.BatchSize = 100
	}
}

// Run blocks until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) error {
	w.applyDefaults()
	slog.InfoContext(ctx, "billing_reconcile_starting",
		slog.Duration("interval", w.Interval),
		slog.Duration("stuck_after", w.StuckAfter))

	w.tick(ctx)
	tk := time.NewTicker(w.Interval)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.InfoContext(ctx, "billing_reconcile_stopping")
			return ctx.Err()
		case <-tk.C:
			w.tick(ctx)
		}
	}
}

func (w *Worker) tick(ctx context.Context) {
	if n, err := w.Orders.ExpireStale(ctx, w.ExpireAfter); err != nil {
		slog.ErrorContext(ctx, "billing_reconcile_expire_failed", slog.String("err", err.Error()))
	} else if n > 0 {
		slog.InfoContext(ctx, "billing_reconcile_expired", slog.Int64("count", n))
	}

	stuck, err := w.Orders.ListStuck(ctx, w.StuckAfter, w.BatchSize)
	if err != nil {
		slog.ErrorContext(ctx, "billing_reconcile_list_failed", slog.String("err", err.Error()))
		return
	}
	var redriven, failed int
	for _, o := range stuck {
		if ctx.Err() != nil {
			break
		}
		if err := w.Driver.Drive(ctx, o.ID); err != nil {
			failed++
			slog.WarnContext(ctx, "billing_reconcile_redrive_failed",
				slog.String("order_id", o.ID.String()),
				slog.String("status", o.Status),
				slog.String("err", err.Error()))
			continue
		}
		redriven++
	}
	if len(stuck) > 0 {
		slog.InfoContext(ctx, "billing_reconcile_tick_done",
			slog.Int("redriven", redriven), slog.Int("failed", failed))
	}
}
